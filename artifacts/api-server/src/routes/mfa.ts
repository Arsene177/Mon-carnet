// Two-step sign-in with an authenticator app: setup, sign-in check, recovery codes and the
// administrator reset for an account holder who lost both their phone and their recovery codes.
// Supabase Auth holds the authenticator factor and checks codes; recovery codes are the app's own.
import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  auditEventsTable,
  db,
  mfaRecoveryCodesTable,
  notificationsTable,
  usersTable,
} from "@workspace/db";
import {
  DisableMfaBody,
  EnableMfaBody,
  EnableMfaResponse,
  GetMfaStatusResponse,
  RegenerateMfaRecoveryCodesBody,
  RegenerateMfaRecoveryCodesResponse,
  ResetAdminUserMfaParams,
  ResetAdminUserMfaResponse,
  StartMfaSetupBody,
  StartMfaSetupResponse,
} from "@workspace/api-zod";
import {
  endSessions,
  requireAuth,
  sessionTokens,
  userResponse,
  verifyAccountPassword,
} from "../lib/medichain-auth";
import {
  MFA_REQUIRED_ROLES,
  USED_CODE_MINUTES,
  hashAuthenticatorCode,
  hashRecoveryCode,
  looksLikeAuthenticatorCode,
  looksLikeRecoveryCode,
  newRecoveryCodes,
} from "../lib/mfa";
import { deleteFactor, enrollTotp, listFactors, verifyTotp, type SupabaseSession } from "../lib/supabase";
import { languageOf, notificationMessages } from "../lib/notification-messages";
import { invalidBody } from "./medichain";
import { recordSecurityEvent } from "../lib/security-events";
import { accountSecretLimiter } from "../lib/rate-limits";

type UserRow = typeof usersTable.$inferSelect;
type Executor = Pick<typeof db, "insert" | "delete">;

const router: IRouter = Router();

async function storeRecoveryCodes(executor: Executor, userId: number): Promise<string[]> {
  const codes = newRecoveryCodes();
  await executor.delete(mfaRecoveryCodesTable).where(eq(mfaRecoveryCodesTable.userId, userId));
  await executor.insert(mfaRecoveryCodesTable).values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })));
  return codes;
}

/** Removes the account's authenticator factors in Supabase Auth and its recovery codes. */
export async function removeAuthenticator(user: UserRow): Promise<void> {
  if (user.authUserId) {
    for (const factor of await listFactors(user.authUserId)) await deleteFactor(user.authUserId, factor.id);
  }
  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ mfaEnabledAt: null, mfaLastCodeHash: null, mfaLastCodeAt: null }).where(eq(usersTable.id, user.id));
    await tx.delete(mfaRecoveryCodesTable).where(eq(mfaRecoveryCodesTable.userId, user.id));
  });
}

/** Records an accepted authenticator code. False when the same code was already accepted in the last few minutes. */
async function claimAuthenticatorCode(userId: number, code: string): Promise<boolean> {
  const codeHash = hashAuthenticatorCode(userId, code);
  const [claimed] = await db
    .update(usersTable)
    .set({ mfaLastCodeHash: codeHash, mfaLastCodeAt: new Date() })
    .where(and(
      eq(usersTable.id, userId),
      or(
        isNull(usersTable.mfaLastCodeHash),
        ne(usersTable.mfaLastCodeHash, codeHash),
        isNull(usersTable.mfaLastCodeAt),
        sql`${usersTable.mfaLastCodeAt} < now() - make_interval(mins => ${USED_CODE_MINUTES})`,
      ),
    ))
    .returning({ id: usersTable.id });
  return Boolean(claimed);
}

async function spendRecoveryCode(user: UserRow, code: string): Promise<boolean> {
  const [spent] = await db
    .update(mfaRecoveryCodesTable)
    .set({ usedAt: new Date() })
    .where(and(
      eq(mfaRecoveryCodesTable.userId, user.id),
      eq(mfaRecoveryCodesTable.codeHash, hashRecoveryCode(code)),
      isNull(mfaRecoveryCodesTable.usedAt),
    ))
    .returning({ id: mfaRecoveryCodesTable.id });
  if (!spent) return false;
  await db.insert(auditEventsTable).values({
    actorUserId: user.id,
    action: "MFA_RECOVERY_CODE_USED",
    entityType: "account",
    entityId: user.id,
  });
  return true;
}

async function verifiedFactorId(user: UserRow): Promise<string | null> {
  if (!user.authUserId) return null;
  const factor = (await listFactors(user.authUserId)).find((item) => item.factor_type === "totp" && item.status === "verified");
  return factor?.id ?? null;
}

export type SecondFactorResult =
  | { ok: false }
  | { ok: true; kind: "authenticator"; session: SupabaseSession }
  | { ok: true; kind: "recovery" };

/**
 * Checks the second step for an account with two-step sign-in on, using the given session: a code
 * from the authenticator app (which raises the session to the second level and returns its new
 * tokens; each code works once), or an unused recovery code (which is then spent).
 */
export async function verifySecondFactor(user: UserRow, code: string, accessToken: string): Promise<SecondFactorResult> {
  if (!user.mfaEnabledAt) return { ok: false };
  if (looksLikeRecoveryCode(code)) {
    return (await spendRecoveryCode(user, code)) ? { ok: true, kind: "recovery" } : { ok: false };
  }
  if (!looksLikeAuthenticatorCode(code)) return { ok: false };
  const cleaned = code.replace(/\s/g, "");
  const factorId = await verifiedFactorId(user);
  if (!factorId) return { ok: false };
  const session = await verifyTotp(accessToken, factorId, cleaned);
  if (!session || !(await claimAuthenticatorCode(user.id, cleaned))) return { ok: false };
  return { ok: true, kind: "authenticator", session };
}

async function loadUser(userId: number): Promise<UserRow | undefined> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return user;
}

router.get("/auth/mfa", requireAuth(), async (req, res): Promise<void> => {
  const user = await loadUser(req.currentUser!.id);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [remaining] = await db
    .select({ value: count() })
    .from(mfaRecoveryCodesTable)
    .where(and(eq(mfaRecoveryCodesTable.userId, user.id), isNull(mfaRecoveryCodesTable.usedAt)));
  res.json(GetMfaStatusResponse.parse({
    enabled: Boolean(user.mfaEnabledAt),
    required: MFA_REQUIRED_ROLES.has(user.role),
    recoveryCodesRemaining: user.mfaEnabledAt ? remaining.value : 0,
  }));
});

router.post("/auth/mfa/setup", requireAuth(), accountSecretLimiter, async (req, res): Promise<void> => {
  const parsed = StartMfaSetupBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter your password.");
    return;
  }
  const user = await loadUser(req.currentUser!.id);
  if (!user || !(await verifyAccountPassword(user, parsed.data.password))) {
    res.status(400).json({ error: "Current password is incorrect." });
    return;
  }
  if (user.mfaEnabledAt) {
    res.status(409).json({ error: "Two-step sign-in is already on." });
    return;
  }
  // A setup that was started and never confirmed is replaced.
  for (const factor of await listFactors(user.authUserId!)) {
    if (factor.status !== "verified") await deleteFactor(user.authUserId!, factor.id);
  }
  const factor = await enrollTotp(req.currentSession!.accessToken);
  res.json(StartMfaSetupResponse.parse({ secret: factor.secret, otpauthUrl: factor.uri }));
});

router.post("/auth/mfa/enable", requireAuth(), accountSecretLimiter, async (req, res): Promise<void> => {
  const parsed = EnableMfaBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter the 6-digit code from your authenticator app.");
    return;
  }
  const user = await loadUser(req.currentUser!.id);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (user.mfaEnabledAt) {
    res.status(409).json({ error: "Two-step sign-in is already on." });
    return;
  }
  const pending = (await listFactors(user.authUserId!)).find((factor) => factor.factor_type === "totp" && factor.status === "unverified");
  if (!pending) {
    res.status(409).json({ error: "Start the setup again." });
    return;
  }
  const code = parsed.data.code.replace(/\s/g, "");
  const session = looksLikeAuthenticatorCode(code) ? await verifyTotp(req.currentSession!.accessToken, pending.id, code) : null;
  if (!session) {
    res.status(400).json({ error: "The code is incorrect or expired. Check that your phone's time is set automatically, then try the newest code." });
    return;
  }
  const recoveryCodes = await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({ mfaEnabledAt: new Date(), mfaLastCodeHash: hashAuthenticatorCode(user.id, code), mfaLastCodeAt: new Date() })
      .where(eq(usersTable.id, user.id));
    const codes = await storeRecoveryCodes(tx, user.id);
    await tx.insert(auditEventsTable).values({ actorUserId: user.id, action: "MFA_ENABLED", entityType: "account", entityId: user.id });
    return codes;
  });
  // Anyone already signed in with only the password is signed out.
  await endSessions(user.authUserId, session.sessionId);
  res.json(EnableMfaResponse.parse({ recoveryCodes, ...sessionTokens(session) }));
});

router.post("/auth/mfa/disable", requireAuth(), accountSecretLimiter, async (req, res): Promise<void> => {
  const parsed = DisableMfaBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter your password and a code from your authenticator app.");
    return;
  }
  const user = await loadUser(req.currentUser!.id);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (MFA_REQUIRED_ROLES.has(user.role)) {
    res.status(403).json({ error: "Doctors and administrators must keep two-step sign-in on." });
    return;
  }
  if (!(await verifyAccountPassword(user, parsed.data.password)) || !(await verifySecondFactor(user, parsed.data.code, req.currentSession!.accessToken)).ok) {
    res.status(400).json({ error: "The password or code is incorrect." });
    return;
  }
  await removeAuthenticator(user);
  await db.insert(auditEventsTable).values({ actorUserId: user.id, action: "MFA_DISABLED", entityType: "account", entityId: user.id });
  res.status(204).end();
});

router.post("/auth/mfa/recovery-codes", requireAuth(), accountSecretLimiter, async (req, res): Promise<void> => {
  const parsed = RegenerateMfaRecoveryCodesBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter your password and a code from your authenticator app.");
    return;
  }
  const user = await loadUser(req.currentUser!.id);
  if (!user || !user.mfaEnabledAt) {
    res.status(409).json({ error: "Turn on two-step sign-in first." });
    return;
  }
  // Only an authenticator code here: a recovery code would remove the authenticator.
  if (!(await verifyAccountPassword(user, parsed.data.password)) || looksLikeRecoveryCode(parsed.data.code) || !(await verifySecondFactor(user, parsed.data.code, req.currentSession!.accessToken)).ok) {
    res.status(400).json({ error: "The password or code is incorrect." });
    return;
  }
  const recoveryCodes = await db.transaction(async (tx) => {
    const codes = await storeRecoveryCodes(tx, user.id);
    await tx.insert(auditEventsTable).values({ actorUserId: user.id, action: "MFA_RECOVERY_CODES_REGENERATED", entityType: "account", entityId: user.id });
    return codes;
  });
  res.json(RegenerateMfaRecoveryCodesResponse.parse({ recoveryCodes }));
});

router.post("/admin/users/:userId/mfa/reset", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const parsedParams = ResetAdminUserMfaParams.safeParse(req.params);
  if (!parsedParams.success) {
    invalidBody(res, "Choose a valid account.");
    return;
  }
  const targetId = parsedParams.data.userId;
  if (targetId === req.currentUser!.id) {
    res.status(400).json({ error: "Another administrator must reset your two-step sign-in." });
    return;
  }
  const [target] = await db.select().from(usersTable).where(and(eq(usersTable.id, targetId), isNull(usersTable.closedAt))).limit(1);
  if (!target) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  await removeAuthenticator(target);
  await endSessions(target.authUserId);
  await db.transaction(async (tx) => {
    await tx.insert(auditEventsTable).values({ actorUserId: req.currentUser!.id, action: "MFA_RESET_BY_ADMIN", entityType: "account", entityId: targetId });
    await tx.insert(notificationsTable).values({
      batchId: randomUUID(),
      senderId: req.currentUser!.id,
      recipientId: targetId,
      ...notificationMessages.mfaReset(languageOf(target.preferredLanguage)),
    });
  });
  const updated = (await loadUser(targetId))!;
  await recordSecurityEvent({
    type: "MFA_RESET_BY_ADMIN",
    severity: "warning",
    userId: req.currentUser!.id,
    details: { adminName: req.currentUser!.name, accountName: updated.name, accountEmail: updated.email },
    subject: String(updated.id),
    actingAdminId: req.currentUser!.id,
  });
  res.json(ResetAdminUserMfaResponse.parse(userResponse(updated)));
});

export default router;
