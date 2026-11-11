// Supabase Auth (accounts, sessions, two-step sign-in) and Supabase Storage (lab files).
//
// Only the API server talks to Supabase, with the project's secret key. The web app never holds a
// Supabase key: it signs in, refreshes and signs out through /api/auth/*, so the app's rate limits,
// account lock, audit log and security alerts apply to every sign-in.
//
// Environment:
//   SUPABASE_URL          https://<project>.supabase.co
//   SUPABASE_SECRET_KEY   the project's secret key (sb_secret_...), or the legacy service_role key
//                         (SUPABASE_SERVICE_ROLE_KEY is accepted as well)
//   SUPABASE_JWT_SECRET   only for projects that still sign tokens with the legacy JWT secret;
//                         projects using JWT signing keys are verified with the published public keys
//   SUPABASE_STORAGE_BUCKET  private bucket for lab files (default "medical-attachments")
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type JsonWebKeyInput, type KeyObject } from "node:crypto";

export type SupabaseSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  authUserId: string;
  sessionId: string;
  factors: Array<{ id: string; status: string; factor_type: string }>;
};

export type TokenClaims = { authUserId: string; sessionId: string; aal: "aal1" | "aal2"; expiresAt: number };

export class SupabaseError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
  }
}

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set.");
  return { url, key };
}

export const storageBucket = () => process.env.SUPABASE_STORAGE_BUCKET ?? "medical-attachments";

async function request(path: string, init: { method?: string; body?: unknown; token?: string; raw?: Uint8Array; headers?: Record<string, string> } = {}) {
  const { url, key } = config();
  const response = await fetch(url + path, {
    method: init.method ?? "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${init.token ?? key}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const body = (data ?? {}) as { error_code?: string; code?: string | number; error?: string; msg?: string; message?: string };
    throw new SupabaseError(response.status, body.error_code ?? (typeof body.code === "string" ? body.code : undefined) ?? body.error, body.msg ?? body.message ?? `Supabase answered ${response.status}`);
  }
  return data;
}

// ---- Auth: users and sessions ----------------------------------------------------------------

type GoTrueSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: { id: string; factors?: Array<{ id: string; status: string; factor_type: string }> };
};

function toSession(raw: GoTrueSession): SupabaseSession {
  const claims = decodeClaims(raw.access_token);
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: new Date(raw.expires_at * 1000).toISOString(),
    authUserId: raw.user.id,
    sessionId: String(claims.session_id ?? ""),
    factors: raw.user.factors ?? [],
  };
}

/** Creates a confirmed Supabase Auth user. Throws SupabaseError with code "email_exists" for a taken email. */
export async function createAuthUser(email: string, password: string): Promise<string> {
  const user = await request("/auth/v1/admin/users", { method: "POST", body: { email, password, email_confirm: true } }) as { id: string };
  return user.id;
}

/** Creates a Supabase Auth user that cannot sign in with a password until one is set (used when copying accounts). */
export async function createAuthUserWithoutPassword(email: string): Promise<string> {
  const user = await request("/auth/v1/admin/users", { method: "POST", body: { email, email_confirm: true } }) as { id: string };
  return user.id;
}

/** Sets a password as an administrator. Supabase Auth ends every session of the user. */
export async function setAuthPassword(authUserId: string, password: string): Promise<void> {
  await request(`/auth/v1/admin/users/${authUserId}`, { method: "PUT", body: { password } });
}

/**
 * Changes the signed-in user's own password. Supabase Auth ends the user's other sessions and keeps
 * this one. (Needs "Secure password change" off in the project: the app checks the current password itself.)
 */
export async function changeOwnPassword(accessToken: string, password: string): Promise<void> {
  await request("/auth/v1/user", { method: "PUT", token: accessToken, body: { password } });
}

/** Deletes a Supabase Auth user and all of its sessions. A user that no longer exists counts as deleted. */
export async function deleteAuthUser(authUserId: string): Promise<void> {
  try {
    await request(`/auth/v1/admin/users/${authUserId}`, { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof SupabaseError && error.status === 404)) throw error;
  }
}

/** Signs in with email and password. Returns null when they do not match. */
export async function passwordSignIn(email: string, password: string): Promise<SupabaseSession | null> {
  try {
    return toSession(await request("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } }) as GoTrueSession);
  } catch (error) {
    if (error instanceof SupabaseError && error.status === 400) return null;
    throw error;
  }
}

/** Exchanges a refresh token for a new session. Returns null when the token is no longer valid. */
export async function refreshSession(refreshToken: string): Promise<SupabaseSession | null> {
  try {
    return toSession(await request("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: refreshToken } }) as GoTrueSession);
  } catch (error) {
    if (error instanceof SupabaseError && (error.status === 400 || error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}

// ---- Auth: two-step sign-in (TOTP factors) ---------------------------------------------------

export type Factor = { id: string; status: "verified" | "unverified"; factor_type: string };

export async function listFactors(authUserId: string): Promise<Factor[]> {
  return await request(`/auth/v1/admin/users/${authUserId}/factors`) as Factor[];
}

export async function deleteFactor(authUserId: string, factorId: string): Promise<void> {
  try {
    await request(`/auth/v1/admin/users/${authUserId}/factors/${factorId}`, { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof SupabaseError && error.status === 404)) throw error;
  }
}

/** Starts authenticator setup for the signed-in user. Returns the new factor, its secret and the otpauth link. */
export async function enrollTotp(accessToken: string): Promise<{ factorId: string; secret: string; uri: string }> {
  const result = await request("/auth/v1/factors", {
    method: "POST",
    token: accessToken,
    body: { factor_type: "totp", issuer: "Mon carnet", friendly_name: `Mon carnet ${Date.now()}` },
  }) as { id: string; totp: { secret: string; uri: string } };
  return { factorId: result.id, secret: result.totp.secret, uri: result.totp.uri };
}

/**
 * Checks a 6-digit code against a factor. On success the session is raised to the second level
 * (aal2) and the new tokens are returned; a wrong code returns null.
 */
export async function verifyTotp(accessToken: string, factorId: string, code: string): Promise<SupabaseSession | null> {
  try {
    const challenge = await request(`/auth/v1/factors/${factorId}/challenge`, { method: "POST", token: accessToken, body: {} }) as { id: string };
    return toSession(await request(`/auth/v1/factors/${factorId}/verify`, { method: "POST", token: accessToken, body: { challenge_id: challenge.id, code } }) as GoTrueSession);
  } catch (error) {
    if (error instanceof SupabaseError && (error.status === 400 || error.status === 422)) return null;
    throw error;
  }
}

// ---- Verifying access tokens -----------------------------------------------------------------

function decodeClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

let jwks: { keys: Map<string, KeyObject>; fetchedAt: number } | null = null;

async function signingKey(kid: string | undefined): Promise<KeyObject | null> {
  const stale = !jwks || Date.now() - jwks.fetchedAt > 10 * 60_000;
  if (stale || (kid && !jwks!.keys.has(kid))) {
    // Refetch at most every 30 seconds, even for unknown key ids.
    if (stale || Date.now() - jwks!.fetchedAt > 30_000) {
      const { keys } = await request("/auth/v1/.well-known/jwks.json") as { keys: Array<JsonWebKeyInput["key"] & { kid?: string }> };
      jwks = { keys: new Map(keys.map((key) => [key.kid ?? "", createPublicKey({ key, format: "jwk" })])), fetchedAt: Date.now() };
    }
  }
  if (kid) return jwks!.keys.get(kid) ?? null;
  return jwks!.keys.size === 1 ? [...jwks!.keys.values()][0]! : null;
}

/**
 * Checks the signature and expiry of a Supabase access token. It does not check that the session
 * still exists: requireAuth does that against the database, so a signed-out session stops at once.
 */
export async function verifyAccessToken(token: string): Promise<TokenClaims | null> {
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) return null;
  let header: { alg?: string; kid?: string };
  try { header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")); } catch { return null; }
  const signed = Buffer.from(`${headerPart}.${payloadPart}`);
  const signature = Buffer.from(signaturePart, "base64url");
  try {
    if (header.alg === "HS256") {
      const secret = process.env.SUPABASE_JWT_SECRET;
      if (!secret) return null;
      const expected = createHmac("sha256", secret).update(signed).digest();
      if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) return null;
    } else if (header.alg === "ES256" || header.alg === "RS256") {
      const key = await signingKey(header.kid);
      if (!key) return null;
      const valid = header.alg === "ES256"
        ? verifySignature("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature)
        : verifySignature("sha256", signed, key, signature);
      if (!valid) return null;
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const claims = decodeClaims(token);
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof claims.sub !== "string" ||
    typeof claims.session_id !== "string" ||
    typeof claims.exp !== "number" || claims.exp <= now ||
    claims.role !== "authenticated" ||
    (claims.aal !== "aal1" && claims.aal !== "aal2")
  ) {
    return null;
  }
  return { authUserId: claims.sub, sessionId: claims.session_id, aal: claims.aal, expiresAt: claims.exp };
}

/**
 * Run at startup: creates the private lab-file bucket if needed, and checks that access tokens can
 * be verified (published signing keys, or SUPABASE_JWT_SECRET for the legacy JWT secret).
 */
export async function checkSupabaseSetup(): Promise<void> {
  config();
  await ensureStorageBucket();
  const { keys } = await request("/auth/v1/.well-known/jwks.json") as { keys: unknown[] };
  if (keys.length === 0 && !process.env.SUPABASE_JWT_SECRET) {
    throw new Error("This Supabase project signs tokens with the legacy JWT secret: set SUPABASE_JWT_SECRET (Project Settings > JWT Keys), or move the project to JWT signing keys.");
  }
}

// ---- Storage ---------------------------------------------------------------------------------

const objectUrl = (bucket: string, objectName: string) => `/storage/v1/object/${bucket}/${objectName.split("/").map(encodeURIComponent).join("/")}`;

/** Creates a private bucket if it does not exist yet, and refuses to work with a public one. */
export async function ensureStorageBucket(bucket = storageBucket(), options: { fileSizeLimit?: number; mimeTypes?: string[] } = { fileSizeLimit: 10 * 1024 * 1024, mimeTypes: ["application/pdf", "image/png", "image/jpeg"] }): Promise<void> {
  try {
    await request("/storage/v1/bucket", {
      method: "POST",
      body: {
        id: bucket,
        name: bucket,
        public: false,
        ...(options.fileSizeLimit ? { file_size_limit: options.fileSizeLimit } : {}),
        ...(options.mimeTypes ? { allowed_mime_types: options.mimeTypes } : {}),
      },
    });
  } catch (error) {
    if (!(error instanceof SupabaseError && (error.status === 409 || /duplicate|already exists/i.test(`${error.code} ${error.message}`)))) throw error;
  }
  const info = await request(`/storage/v1/bucket/${bucket}`) as { public?: boolean };
  if (info.public) throw new Error(`The storage bucket "${bucket}" is public. Medical files and backups must be in a private bucket.`);
}

/** A URL the browser can PUT one file to (valid for 2 hours, set by Supabase). */
export async function signedUploadUrl(objectName: string, bucket = storageBucket()): Promise<string> {
  const { url } = config();
  const result = await request(`/storage/v1/object/upload/sign/${bucket}/${objectName}`, { method: "POST" }) as { url: string };
  return `${url}/storage/v1${result.url}`;
}

/** A URL the browser can download one file from for `ttlSeconds`. */
export async function signedDownloadUrl(objectName: string, ttlSeconds: number, bucket = storageBucket()): Promise<string> {
  const { url } = config();
  const result = await request(`/storage/v1/object/sign/${bucket}/${objectName}`, { method: "POST", body: { expiresIn: ttlSeconds } }) as { signedURL: string };
  return `${url}/storage/v1${result.signedURL}`;
}

/** True when the file exists in the bucket. */
export async function objectExists(objectName: string, bucket = storageBucket()): Promise<boolean> {
  try {
    await request(`/storage/v1/object/info/${bucket}/${objectName}`);
    return true;
  } catch (error) {
    if (error instanceof SupabaseError && (error.status === 400 || error.status === 404)) return false;
    throw error;
  }
}

/** Deletes files; files that are already gone are ignored. */
export async function deleteObjects(objectNames: string[], bucket = storageBucket()): Promise<void> {
  for (let offset = 0; offset < objectNames.length; offset += 100) {
    await request(`/storage/v1/object/${bucket}`, { method: "DELETE", body: { prefixes: objectNames.slice(offset, offset + 100) } });
  }
}

export async function downloadObject(objectName: string, bucket = storageBucket()): Promise<Buffer> {
  const { url, key } = config();
  const response = await fetch(url + objectUrl(bucket, objectName), { headers: { apikey: key, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new SupabaseError(response.status, undefined, `Downloading ${objectName} failed with HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

export async function uploadObject(objectName: string, data: Buffer, contentType: string, bucket = storageBucket()): Promise<void> {
  try {
    await request(objectUrl(bucket, objectName), { method: "POST", raw: new Uint8Array(data), headers: { "content-type": contentType, "x-upsert": "true" } });
  } catch (error) {
    if (error instanceof SupabaseError && error.status === 413) {
      throw new Error(`${objectName} (${(data.length / 1024 / 1024).toFixed(1)} MB) is larger than the project's upload limit. Raise it in Supabase (Storage > Settings) or keep this file elsewhere.`);
    }
    throw error;
  }
}
