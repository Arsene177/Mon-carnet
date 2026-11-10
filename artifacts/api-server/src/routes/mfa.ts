// Two-step sign-in with an authenticator app: setup, sign-in check, recovery codes and the
// administrator reset for an account holder who lost both their phone and their recovery codes.
import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, count, eq, isNull, lt, or } from "drizzle-orm";
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
  createAccessToken,
  nextSessionVersion,
  publicUser,
  requireAuth,
  userResponse,
  verifyPassword,
} from "../lib/medichain-auth";
import {
  MFA_REQUIRED_ROLES,
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUrl,
  verifyTotp,
} from "../lib/mfa";
import { languageOf, notificationMessages } from "../lib/notification-messages";
import { invalidBody } from "./medichain";
import { recordSecurityEvent } from "../lib/security-events";

type UserRow = typeof usersTable.$inferSelect;
type Executor = Pick<typeof db, "insert" | "delete">;

const router: IRouter = Router();

async function storeRecoveryCodes(executor: Executor, userId: number): Promise<string[]> {
  const codes = newRecoveryCodes();
  await executor.delete(mfaRecoveryCodesTable).where(eq(mfaRecoveryCodesTable.userId, userId));
  await executor.insert(mfaRecoveryCodesTable).values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })));
  return codes;
}

/**
 * Checks the second step for an account with two-step sign-in on: a code from the authenticator
 * app, or an unused recovery code (which is then spent). Each authenticator code works once.
 */
export async function verifySecondFactor(user: UserRow, code: string): Promise<boolean> {
  if (!user.mfaEnabledAt || !user.mfaSecret) return false;
  if (looksLikeRecoveryCode(code)) {
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
  const secret = decryptSecret(user.mfaSecret);
  if (!secret) return false;
  const step = verifyTotp(secret, code, user.mfaLastUsedStep);
  if (step === null) return false;
  // Only one request can move the last used step forward, so a code cannot be used twice.
  const [claimed] = await db
    .update(usersTable)
    .set({ mfaLastUsedStep: step })
    .where(and(
      eq(usersTable.id, user.id),
      or(isNull(usersTable.mfaLastUsedStep), lt(usersTable.mfaLastUsedStep, step)),
    ))
    .returning({ id: usersTable.id });
  return Boolean(claimed);
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

router.post("/auth/mfa/setup", requireAuth(), async (req, res): Promise<void> => {
  const parsed = StartMfaSetupBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter your password.");
    return;
  }
  const user = await loadUser(req.currentUser!.id);
  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    res.status(400).json({ error: "Current password is incorrect." });
    return;
  }
  if (user.mfaEnabledAt) {
    res.status(409).json({ error: "Two-step sign-in is already on." });
    return;
  }
  const secret = newTotpSecret();
  await db.update(usersTable).set({ mfaPendingSecret: encryptSecret(secret) }).where(eq(usersTable.id, user.id));
  res.json(StartMfaSetupResponse.parse({ secret, otpauthUrl: otpauthUrl(secret, user.email) }));
});

router.post("/auth/mfa/enable", requireAuth(), async (req, res): Promise<void> => {
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
  const secret = user.mfaPendingSecret ? decryptSecret(user.mfaPendingSecret) : null;
  if (!secret) {
    res.status(409).json({ error: "Start the setup again." });
    return;
  }
  const step = verifyTotp(secret, parsed.data.code, null);
  if (step === null) {
    res.status(400).json({ error: "The code is incorrect or expired. Check that your phone's time is set automatically, then try the newest code." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(usersTable)
      .set({
        mfaSecret: user.mfaPendingSecret,
        mfaPendingSecret: null,
        mfaEnabledAt: new Date(),
        mfaLastUsedStep: step,
        // Anyone already signed in with only the password is signed out.
        sessionVersion: nextSessionVersion(),
      })
      .where(and(eq(usersTable.id, user.id), isNull(usersTable.mfaEnabledAt)))
      .returning();
    if (!updated) return null;
    const recoveryCodes = await storeRecoveryCodes(tx, user.id);
    await tx.insert(auditEventsTable).values({ actorUserId: user.id, action: "MFA_ENABLED", entityType: "account", entityId: user.id });
    return { updated, recoveryCodes };
  });
  if (!result) {
    res.status(409).json({ error: "Two-step sign-in is already on." });
    return;
  }
  res.json(EnableMfaResponse.parse({
    recoveryCodes: result.recoveryCodes,
    token: createAccessToken(publicUser(result.updated), result.updated.sessionVersion),
  }));
});

router.post("/auth/mfa/disable", requireAuth(), async (req, res): Promise<void> => {
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
  if (!verifyPassword(parsed.data.password, user.passwordHash) || !(await verifySecondFactor(user, parsed.data.code))) {
    res.status(400).json({ error: "The password or code is incorrect." });
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({ mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastUsedStep: null })
      .where(eq(usersTable.id, user.id));
    await tx.delete(mfaRecoveryCodesTable).where(eq(mfaRecoveryCodesTable.userId, user.id));
    await tx.insert(auditEventsTable).values({ actorUserId: user.id, action: "MFA_DISABLED", entityType: "account", entityId: user.id });
  });
  res.status(204).end();
});

router.post("/auth/mfa/recovery-codes", requireAuth(), async (req, res): Promise<void> => {
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
  if (!verifyPassword(parsed.data.password, user.passwordHash) || !(await verifySecondFactor(user, parsed.data.code))) {
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
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(usersTable)
      .set({ mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastUsedStep: null, sessionVersion: nextSessionVersion() })
      .where(and(eq(usersTable.id, targetId), isNull(usersTable.closedAt)))
      .returning();
    if (!row) return null;
    await tx.delete(mfaRecoveryCodesTable).where(eq(mfaRecoveryCodesTable.userId, targetId));
    await tx.insert(auditEventsTable).values({ actorUserId: req.currentUser!.id, action: "MFA_RESET_BY_ADMIN", entityType: "account", entityId: targetId });
    await tx.insert(notificationsTable).values({
      batchId: randomUUID(),
      senderId: req.currentUser!.id,
      recipientId: targetId,
      ...notificationMessages.mfaReset(languageOf(row.preferredLanguage)),
    });
    return row;
  });
  if (!updated) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
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
