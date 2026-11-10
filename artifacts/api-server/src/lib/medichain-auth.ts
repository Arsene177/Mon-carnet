import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { eq, lt, sql } from "drizzle-orm";
import { db, revokedTokensTable, usersTable } from "@workspace/db";
import { MFA_REQUIRED_ROLES } from "./mfa";

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

declare global {
  namespace Express {
    interface Request {
      currentUser?: CurrentUser;
      /** The id and expiry (seconds) of the token used for this request, for signing out. */
      accessToken?: { id: string | null; expiresAt: number };
    }
  }
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? process.env.SESSION_SECRET;
  if (!secret || secret.length < 24) {
    throw new Error("A JWT_SECRET or SESSION_SECRET of at least 24 characters is required.");
  }
  return secret;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/** A real scrypt hash of a random password, so that sign-in takes as long for an unknown email as for a known one. */
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

/** Spends the same time as checking a real password, for accounts that do not exist. */
export function verifyDummyPassword(password: string): false {
  verifyPassword(password, DUMMY_HASH);
  return false;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, salt, hash] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  try {
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/** Sessions end 12 hours after sign-in at the latest (ASVS 3.3.2); the web app also signs out after 30 idle minutes. */
export const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;

/**
 * Issues an access token valid for 12 hours, with its own id so that signing out can revoke it. `sessionVersion` is the account's current value; raising it
 * (see `endAllSessions`) makes every token issued before that point stop working.
 */
export function createAccessToken(user: CurrentUser, sessionVersion: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.id,
      role: user.role,
      status: user.status,
      sv: sessionVersion,
      jti: randomBytes(16).toString("base64url"),
      iat: now,
      exp: now + SESSION_LIFETIME_SECONDS,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", getJwtSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

type AccessTokenClaims = {
  id: number;
  role: MedichainRole;
  status: MedichainStatus;
  sessionVersion: number;
  tokenId: string | null;
  expiresAt: number;
};

function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    if (!headerPart || !payloadPart || !signaturePart) return null;
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as {
      alg?: string;
    };
    if (header.alg !== "HS256") return null;
    const unsigned = `${headerPart}.${payloadPart}`;
    const expected = createHmac("sha256", getJwtSecret()).update(unsigned).digest();
    const actual = Buffer.from(signaturePart, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      sub?: unknown;
      role?: unknown;
      status?: unknown;
      sv?: unknown;
      jti?: unknown;
      exp?: unknown;
    };
    if (
      !Number.isInteger(payload.sub) ||
      !["PATIENT", "PENDING_DOCTOR", "DOCTOR", "ADMIN"].includes(String(payload.role)) ||
      !["PENDING", "ACTIVE", "INACTIVE"].includes(String(payload.status)) ||
      (payload.sv !== undefined && !Number.isInteger(payload.sv)) ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return {
      id: payload.sub as number,
      role: payload.role as MedichainRole,
      status: payload.status as MedichainStatus,
      // Tokens issued before session versions existed carry none; they match the initial value 0
      // until the account's first password change or "sign out of all other devices".
      sessionVersion: (payload.sv as number | undefined) ?? 0,
      tokenId: typeof payload.jti === "string" ? payload.jti : null,
      expiresAt: payload.exp as number,
    };
  } catch {
    return null;
  }
}

export function publicUser(user: typeof usersTable.$inferSelect): CurrentUser {
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

export function userResponse(user: typeof usersTable.$inferSelect) {
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
    mustChangePassword: user.mustChangePassword,
    mfaRequired: MFA_REQUIRED_ROLES.has(user.role),
    createdAt: user.createdAt.toISOString(),
  };
}

/** Account routes a doctor or administrator can use before turning on two-step sign-in. */
function allowedBeforeAccountSetup(req: Request): boolean {
  const path = req.originalUrl.split("?")[0] ?? "";
  return path.startsWith("/api/auth/") || path === "/api/account/consent";
}

export function requireAuth(...roles: MedichainRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authorization = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const claims = match ? verifyAccessToken(match[1]) : null;
    if (!claims) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, claims.id)).limit(1);
    if (!user || !user.isActive) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const currentUser = publicUser(user);
    if (
      currentUser.role !== claims.role ||
      currentUser.status !== claims.status ||
      user.sessionVersion !== claims.sessionVersion
    ) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    // Doctors and administrators must turn on two-step sign-in before anything beyond their own
    // account settings works.
    if (claims.tokenId) {
      const [revoked] = await db.select({ id: revokedTokensTable.tokenId }).from(revokedTokensTable).where(eq(revokedTokensTable.tokenId, claims.tokenId)).limit(1);
      if (revoked) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
    }
    req.accessToken = { id: claims.tokenId, expiresAt: claims.expiresAt };
    // A temporary password from an administrator must be replaced before anything else.
    if (user.mustChangePassword && !allowedBeforeAccountSetup(req)) {
      res.status(403).json({ error: "Choose a new password to continue.", code: "PASSWORD_CHANGE_REQUIRED" });
      return;
    }
    if (MFA_REQUIRED_ROLES.has(currentUser.role) && !user.mfaEnabledAt && !allowedBeforeAccountSetup(req)) {
      res.status(403).json({ error: "Turn on two-step sign-in to continue.", code: "MFA_SETUP_REQUIRED" });
      return;
    }
    if (roles.length > 0 && !roles.includes(currentUser.role)) {
      res.status(403).json({ error: "You do not have access to this resource" });
      return;
    }
    req.currentUser = currentUser;
    next();
  };
}
/** The update that ends every session of an account; use inside `.set({ ... })`. */
export const nextSessionVersion = () => sql`${usersTable.sessionVersion} + 1`;

/**
 * Ends every session of an account by raising its session version. Returns the new version so
 * the caller can issue a fresh token for the device that asked, or undefined when there is no account.
 */
export async function endAllSessions(userId: number): Promise<number | undefined> {
  const [updated] = await db
    .update(usersTable)
    .set({ sessionVersion: nextSessionVersion() })
    .where(eq(usersTable.id, userId))
    .returning({ sessionVersion: usersTable.sessionVersion });
  return updated?.sessionVersion;
}

/** Ends the session of one token (signing out). */
export async function revokeToken(token: { id: string | null; expiresAt: number }): Promise<void> {
  if (!token.id) return;
  await db.insert(revokedTokensTable)
    .values({ tokenId: token.id, expiresAt: new Date(token.expiresAt * 1000) })
    .onConflictDoNothing();
}

/** Deletes revocations of tokens that have expired anyway. */
export async function purgeExpiredRevocations(): Promise<void> {
  await db.delete(revokedTokensTable).where(lt(revokedTokensTable.expiresAt, new Date()));
}
