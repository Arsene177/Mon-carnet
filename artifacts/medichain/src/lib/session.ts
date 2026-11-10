export const SESSION_LAST_ACTIVITY_KEY = 'medichain_last_activity';

/** Keeps this device signed in with a token the server issued after ending the other sessions. */
export function keepThisDeviceSignedIn(token: string) {
  localStorage.setItem('medichain_token', token);
  localStorage.setItem(SESSION_LAST_ACTIVITY_KEY, String(Date.now()));
}
