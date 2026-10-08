import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

export type MedichainRole = "PATIENT" | "PENDING_DOCTOR" | "DOCTOR" | "ADMIN";
export type MedichainStatus = "PENDING" | "ACTIVE" | "INACTIVE";

export type CurrentUser = {
  id: number;
  email: string;
  name: string;
  role: MedichainRole;
  status: MedichainStatus;
};

declare global {
  namespace Express {
    interface Request {
      currentUser?: CurrentUser;
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

export function createAccessToken(user: CurrentUser): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.id,
      role: user.role,
      status: user.status,
      iat: now,
      exp: now + 60 * 60 * 24 * 7,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", getJwtSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifyAccessToken(token: string): { id: number; role: MedichainRole; status: MedichainStatus } | null {
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
      exp?: unknown;
    };
    if (
      !Number.isInteger(payload.sub) ||
      !["PATIENT", "PENDING_DOCTOR", "DOCTOR", "ADMIN"].includes(String(payload.role)) ||
      !["PENDING", "ACTIVE", "INACTIVE"].includes(String(payload.status)) ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return {
      id: payload.sub as number,
      role: payload.role as MedichainRole,
      status: payload.status as MedichainStatus,
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
    isActive: user.isActive,
    createdAt: user.createdAt.toISOString(),
  };
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
    if (currentUser.role !== claims.role || currentUser.status !== claims.status) {
      res.status(401).json({ error: "Authentication required" });
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