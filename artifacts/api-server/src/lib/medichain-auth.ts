import { scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { MFA_REQUIRED_ROLES } from "./mfa";
import { verifyAccessToken, type SupabaseSession } from "./supabase";

export type MedichainRole = "PATIENT" | "PENDING_DOCTOR" | "DOCTOR" | "ADMIN";
export type MedichainStatus = "PENDING" | "ACTIVE" | "INACTIVE";

export type CurrentUser = {
  id: number;
  email: string;
  name: string;
  hospitalName: string | null;
  professionalMedicalNumber: string | null;
  doctorVerified: boolean;
  role: MedichainRole;
  status: MedichainStatus;
};

/** The Supabase session behind the current request. */
export type CurrentSession = {
  authUserId: string;
  sessionId: string;
  aal: "aal1" | "aal2";
  accessToken: string;
};

declare global {
  namespace Express {
    interface Request {
      currentUser?: CurrentUser;
      currentSession?: CurrentSession;
    }
  }
}

type UserRow = typeof usersTable.$inferSelect;

/** Checks a password against the scrypt hash kept for accounts copied from the previous database. */
export function verifyLegacyPassword(password: string, stored: string | null): boolean {
  const [algorithm, salt, hash] = (stored ?? "").split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  try {
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/**
 * Checks the account's current password: the one held by Supabase Auth (bcrypt, compared in the
 * database so no session is created), or the old scrypt hash of an account not yet moved.
 */
export async function verifyAccountPassword(user: UserRow, password: string): Promise<boolean> {
  if (user.passwordHash) return verifyLegacyPassword(password, user.passwordHash);
  if (!user.authUserId) return false;
  const result = await db.execute<{ matches: boolean }>(sql`
    select encrypted_password = extensions.crypt(${password}, encrypted_password) as matches
    from auth.users where id = ${user.authUserId}::uuid and encrypted_password is not null and encrypted_password <> ''`);
  return Boolean(result.rows[0]?.matches);
}

let dummyHash: string | null = null;

/** Spends about as long as a real password check, so unknown emails are not answered faster. */
export async function spendPasswordCheckTime(password: string): Promise<void> {
  if (!dummyHash) {
    const created = await db.execute<{ hash: string }>(sql`select extensions.crypt(${"not-a-password"}, extensions.gen_salt('bf', 10)) as hash`);
    dummyHash = created.rows[0]!.hash;
  }
  await db.execute(sql`select extensions.crypt(${password}, ${dummyHash}) = ${dummyHash} as matches`);
}

/** Ends every Supabase session of an account, or every one except `keepSessionId`. Takes effect on the next request. */
export async function endSessions(authUserId: string | null, keepSessionId?: string): Promise<void> {
  if (!authUserId) return;
  await db.execute(keepSessionId
    ? sql`delete from auth.sessions where user_id = ${authUserId}::uuid and id <> ${keepSessionId}::uuid`
    : sql`delete from auth.sessions where user_id = ${authUserId}::uuid`);
}

/** The token fields returned to the web app after a sign-in, refresh or second step. */
export function sessionTokens(session: SupabaseSession) {
  return { token: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt };
}

export function publicUser(user: UserRow): CurrentUser {
  const status: MedichainStatus = !user.isActive
    ? "INACTIVE"
    : user.role === "PENDING_DOCTOR"
      ? "PENDING"
      : "ACTIVE";
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    hospitalName: user.hospitalName ?? null,
    professionalMedicalNumber: user.professionalMedicalNumber ?? null,
    doctorVerified: user.doctorVerified,
    role: user.role as MedichainRole,
    status,
  };
}

export function userResponse(user: UserRow) {
  const current = publicUser(user);
  return {
    ...current,
    dateOfBirth: user.dateOfBirth ?? null,
    contactInfo: user.contactInfo ?? null,
    hospitalName: user.hospitalName ?? null,
    locationRegion: user.locationRegion ?? null,
    locationArrondissement: user.locationArrondissement ?? null,
    professionalMedicalNumber: user.professionalMedicalNumber ?? null,
    doctorVerified: user.doctorVerified,
    isActive: user.isActive,
    preferredLanguage: user.preferredLanguage === "en" ? "en" : "fr",
    sex: user.sex === "FEMALE" || user.sex === "MALE" ? user.sex : null,
    dateOfBirthEstimated: user.dateOfBirthEstimated,
    termsVersion: user.termsVersion ?? null,
    termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
    healthDataConsentAt: user.healthDataConsentAt?.toISOString() ?? null,
    mfaEnabled: Boolean(user.mfaEnabledAt),
    mfaRequired: MFA_REQUIRED_ROLES.has(user.role),
    createdAt: user.createdAt.toISOString(),
  };
}

/** Account routes a doctor or administrator can use before turning on two-step sign-in. */
function allowedBeforeMfaSetup(req: Request): boolean {
  const path = req.originalUrl.split("?")[0] ?? "";
  return path.startsWith("/api/auth/") || path === "/api/account/consent";
}

/**
 * Accepts a Supabase access token whose session still exists (signing out, a password change or a
 * suspension deletes sessions, which stops their tokens at once) and whose account is active.
 */
export function requireAuth(...roles: MedichainRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authorization = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const claims = match ? await verifyAccessToken(match[1]!) : null;
    if (!claims) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(and(
      eq(usersTable.authUserId, claims.authUserId),
      sql`exists (select 1 from auth.sessions s where s.id = ${claims.sessionId}::uuid and s.user_id = ${claims.authUserId}::uuid and (s.not_after is null or s.not_after > now()))`,
    )).limit(1);
    if (!user || !user.isActive) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    // An account with two-step sign-in on needs a session that passed it. (Without this check,
    // someone with only the password could sign in at Supabase Auth directly and use that token.)
    if (user.mfaEnabledAt && claims.aal !== "aal2") {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const currentUser = publicUser(user);
    // Doctors and administrators must turn on two-step sign-in before anything beyond their own
    // account settings works.
    if (MFA_REQUIRED_ROLES.has(currentUser.role) && !user.mfaEnabledAt && !allowedBeforeMfaSetup(req)) {
      res.status(403).json({ error: "Turn on two-step sign-in to continue.", code: "MFA_SETUP_REQUIRED" });
      return;
    }
    if (roles.length > 0 && !roles.includes(currentUser.role)) {
      res.status(403).json({ error: "You do not have access to this resource" });
      return;
    }
    req.currentUser = currentUser;
    req.currentSession = { authUserId: claims.authUserId, sessionId: claims.sessionId, aal: claims.aal, accessToken: match![1]! };
    next();
  };
}
