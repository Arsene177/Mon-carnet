// The signed-in session on this device: a short-lived access token (about an hour), the refresh
// token that renews it, and when it expires. Sign-in, refresh and sign-out all go through the app's
// API (/api/auth/*); the web app never talks to Supabase directly and holds no Supabase key.
export const SESSION_LAST_ACTIVITY_KEY = 'medichain_last_activity';
export const ACCESS_TOKEN_KEY = 'medichain_token';
const REFRESH_TOKEN_KEY = 'medichain_refresh_token';
const EXPIRES_AT_KEY = 'medichain_token_expires_at';
/** Renew this long before the access token expires. */
const RENEW_BEFORE_MS = 2 * 60_000;

export type SessionTokens = { token: string; refreshToken?: string; expiresAt?: string };

function read(key: string): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
}

export function hasSession(): boolean {
  return Boolean(read(ACCESS_TOKEN_KEY));
}

/** Stores the tokens of a sign-in, refresh or second step. */
export function saveSession(tokens: SessionTokens): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, tokens.token);
  if (tokens.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
  if (tokens.expiresAt) localStorage.setItem(EXPIRES_AT_KEY, String(new Date(tokens.expiresAt).getTime()));
}

/** Forgets the session on this device (and so in every tab, which watch ACCESS_TOKEN_KEY). */
export function clearSession(): void {
  for (const key of [ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, EXPIRES_AT_KEY, SESSION_LAST_ACTIVITY_KEY]) localStorage.removeItem(key);
}

/** Keeps this device signed in after an action that ended the other sessions. */
export function keepThisDeviceSignedIn(tokens: SessionTokens): void {
  saveSession(tokens);
  localStorage.setItem(SESSION_LAST_ACTIVITY_KEY, String(Date.now()));
}

let renewing: Promise<string | null> | null = null;

async function renew(refreshToken: string): Promise<string | null> {
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (response.status === 401) {
    // The session has ended on the server; the next request answers 401 and shows the sign-in page.
    return read(ACCESS_TOKEN_KEY);
  }
  if (!response.ok) return read(ACCESS_TOKEN_KEY);
  const tokens = await response.json() as SessionTokens;
  // Another tab may have signed out meanwhile.
  if (!hasSession()) return null;
  saveSession(tokens);
  return tokens.token;
}

/** The access token to send, renewed first when it is about to expire. */
export async function accessToken(): Promise<string | null> {
  const token = read(ACCESS_TOKEN_KEY);
  if (!token) return null;
  const expiresAt = Number(read(EXPIRES_AT_KEY));
  const refreshToken = read(REFRESH_TOKEN_KEY);
  if (!refreshToken || !expiresAt || expiresAt - Date.now() > RENEW_BEFORE_MS) return token;
  renewing ??= renew(refreshToken).catch(() => token).finally(() => { renewing = null; });
  return renewing;
}

/** fetch() for the app's own API with this device's access token attached. */
export async function authorizedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = await accessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/** Ends the session on the server too (best effort), then forgets it here. */
export function endSession(): void {
  const token = read(ACCESS_TOKEN_KEY);
  if (token) void fetch('/api/auth/sign-out', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, keepalive: true }).catch(() => undefined);
  clearSession();
}
