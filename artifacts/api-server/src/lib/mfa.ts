// Two-step sign-in: Supabase Auth holds the authenticator (TOTP) factors and checks the codes.
// The app adds single-use recovery codes for a lost phone, and refuses an authenticator code that
// was already accepted (Supabase accepts the same code again within its 30-second window).
import { createHash, randomBytes } from "node:crypto";

/** Roles that must use two-step sign-in: they can reach many patients' data. */
export const MFA_REQUIRED_ROLES = new Set(["DOCTOR", "ADMIN"]);

/** How long an accepted authenticator code stays refused: its 30-second window plus clock drift. */
export const USED_CODE_MINUTES = 3;

/** A 6-digit authenticator code, spaces allowed. */
export function looksLikeAuthenticatorCode(code: string): boolean {
  return /^\d{6}$/.test(code.replace(/\s/g, ""));
}

/** Stored instead of the code itself, so the database never holds a usable code. */
export function hashAuthenticatorCode(userId: number, code: string): string {
  return createHash("sha256").update(`mon-carnet-totp:${userId}:${code.replace(/\s/g, "")}`).digest("hex");
}

// ---- Recovery codes -------------------------------------------------------------------------

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i
export const RECOVERY_CODE_COUNT = 10;

/** Ten codes like "k7m2-x9qp", each usable once. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const bytes = randomBytes(8);
    const chars = [...bytes].map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Recovery codes are random (about 39 bits) and single-use, so a fast hash is enough. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(`mon-carnet-recovery:${normalizeRecoveryCode(code)}`).digest("hex");
}

export function looksLikeRecoveryCode(code: string): boolean {
  return /^[a-z0-9]{8}$/.test(normalizeRecoveryCode(code)) && !/^\d+$/.test(normalizeRecoveryCode(code));
}
