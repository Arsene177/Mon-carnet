// Two-step sign-in: time-based one-time codes (TOTP, RFC 6238) from an authenticator app,
// with single-use recovery codes for a lost phone.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and next 30-second step too, for phones whose clock is slightly off. */
const DRIFT_STEPS = 1;
const ISSUER = "Mon carnet";

/** Roles that must use two-step sign-in: they can reach many patients' data. */
export const MFA_REQUIRED_ROLES = new Set(["DOCTOR", "ADMIN"]);

// ---- Encryption of stored secrets ------------------------------------------------------------

/**
 * Key for encrypting TOTP secrets at rest. Use MFA_ENCRYPTION_KEY (at least 32 characters) so the
 * sign-in secret can be rotated on its own; without it the key is derived from JWT_SECRET /
 * SESSION_SECRET, and changing that secret would make every enrolled authenticator stop working.
 */
function encryptionKey(): Buffer {
  const dedicated = process.env.MFA_ENCRYPTION_KEY;
  if (dedicated) {
    if (dedicated.length < 32) throw new Error("MFA_ENCRYPTION_KEY must be at least 32 characters.");
    return Buffer.from(hkdfSync("sha256", dedicated, "mon-carnet", "mfa-secret-v1", 32));
  }
  const fallback = process.env.JWT_SECRET ?? process.env.SESSION_SECRET;
  if (!fallback) throw new Error("Set MFA_ENCRYPTION_KEY or JWT_SECRET to use two-step sign-in.");
  return Buffer.from(hkdfSync("sha256", fallback, "mon-carnet", "mfa-secret-v1", 32));
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptSecret(stored: string): string | null {
  const [version, iv, tag, data] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---- TOTP -----------------------------------------------------------------------------------

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/[\s=]/g, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new random secret, base32-encoded as authenticator apps expect. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Checks a 6-digit code and returns the time step it matched, or null. Codes for steps at or
 * before `lastUsedStep` are refused so an intercepted code cannot be replayed.
 */
export function verifyTotp(secret: string, code: string, lastUsedStep: number | null, now = Date.now()): number | null {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return null;
  const step = currentStep(now);
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset++) {
    const candidate = step + offset;
    if (lastUsedStep !== null && candidate <= lastUsedStep) continue;
    const expected = Buffer.from(totpCode(secret, candidate));
    if (timingSafeEqual(expected, Buffer.from(cleaned))) return candidate;
  }
  return null;
}

/** The link an authenticator app reads from the QR code. */
export function otpauthUrl(secret: string, accountEmail: string): string {
  const label = encodeURIComponent(`${ISSUER}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
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
