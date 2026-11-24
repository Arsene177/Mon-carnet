// Email verification and password reset by email, with a stand-in for Brevo's API that records
// every email. Runs against the local Supabase stack (tests/supabase-test-env.mjs).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DATABASE_URL, SUPABASE_URL, resetDatabase, serverEnv } from "./supabase-test-env.mjs";

const PORT = 7100 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}/api`;
const APP_URL = "https://moncarnet.example";
const PASSWORD = "Correct-horse-9";
const TERMS = "2026-11-draft-1";
const sql = new pg.Pool({ connectionString: DATABASE_URL });
const sent = [];
let brevo;
let server;
let ipCounter = 1;
const newIp = () => `10.88.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
let counter = 0;
const unique = (prefix) => `${prefix}${Date.now().toString(36)}${counter++}`;

async function api(method, path, body, { token } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": newIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
}

const emailsTo = (email) => sent.filter((message) => message.to[0].email === email);
const linkIn = (message, page) => {
  const match = new RegExp(`${APP_URL.replace(/\./g, "\\.")}/${page}\\?token=([A-Za-z0-9_-]+)`).exec(message.textContent);
  assert.ok(match, `a /${page} link in: ${message.textContent}`);
  return match[1];
};

async function register(language = "fr") {
  const email = `${unique("verify")}@test.cm`;
  const result = await api("POST", "/auth/register", {
    name: "Awa Verify", email, password: PASSWORD, role: "PATIENT", sex: "FEMALE", dateOfBirth: "1990-04-12",
    countryOfOrigin: "CM", contactInfo: "+237690000000", acceptedTermsVersion: TERMS, healthDataConsent: true, preferredLanguage: language,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { email, result };
}

before(async () => {
  await resetDatabase(sql);
  await new Promise((resolve) => {
    brevo = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.headers["api-key"] !== "test-brevo-key") { res.statusCode = 401; res.end("{}"); return; }
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.statusCode = 201;
      res.end(JSON.stringify({ messageId: "<test>" }));
    }).listen(0, "127.0.0.1", resolve);
  });
  server = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: serverEnv(PORT, {
      EMAIL_VERIFICATION: "required", BREVO_API_KEY: "test-brevo-key", EMAIL_FROM: "no-reply@moncarnet.example",
      APP_URL, BREVO_API_URL: `http://127.0.0.1:${brevo.address().port}/v3/smtp/email`,
    }),
    stdio: ["ignore", "ignore", "inherit"],
  });
  // Up to 60 seconds: start-up is slower on shared CI machines.
  for (let attempt = 0; attempt < 600; attempt++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The API server did not start.");
});

after(async () => {
  server?.kill();
  brevo?.close();
  await resetDatabase(sql);
  await sql.end();
});

describe("email verification", () => {
  test("a new account gets a confirmation link and cannot sign in before using it", async () => {
    const { email, result } = await register("fr");
    assert.deepEqual([result.body.verificationRequired, result.body.emailSent, result.body.token], [true, true, undefined]);
    const [message] = emailsTo(email);
    assert.match(message.subject, /Confirmez votre adresse e-mail/);
    assert.equal(message.sender.email, "no-reply@moncarnet.example");
    linkIn(message, "verify-email");
    const refused = await api("POST", "/auth/login", { email, password: PASSWORD });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "EMAIL_NOT_VERIFIED");
    // A wrong password does not reveal that the account is waiting for confirmation.
    assert.equal((await api("POST", "/auth/login", { email, password: "Wrong-password-1" })).status, 401);
    // A session made directly at Supabase Auth is refused too.
    const direct = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: process.env.SUPABASE_SECRET_KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }),
    });
    const session = await direct.json();
    assert.equal((await api("GET", "/auth/me", undefined, { token: session.access_token })).status, 401);
  });

  test("the link confirms the address once, and the account can then sign in", async () => {
    const { email } = await register("en");
    const [message] = emailsTo(email);
    assert.match(message.subject, /Confirm your email address/);
    const token = linkIn(message, "verify-email");
    assert.equal((await api("POST", "/auth/verify-email", { token })).status, 200);
    assert.equal((await api("POST", "/auth/verify-email", { token })).status, 400);
    const signedIn = await api("POST", "/auth/login", { email, password: PASSWORD });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.ok(signedIn.body.token);
    const { rows } = await sql.query("select count(*)::int as n from medichain_audit_events where action = 'EMAIL_VERIFIED'");
    assert.ok(rows[0].n >= 1);
  });

  test("asking again sends a new link and the old one stops working; the answer never reveals an account", async () => {
    const { email } = await register();
    const first = linkIn(emailsTo(email)[0], "verify-email");
    const again = await api("POST", "/auth/verification-email", { email });
    assert.equal(again.status, 202);
    assert.equal(emailsTo(email).length, 2);
    const second = linkIn(emailsTo(email)[1], "verify-email");
    assert.equal((await api("POST", "/auth/verify-email", { token: first })).status, 400);
    assert.equal((await api("POST", "/auth/verify-email", { token: second })).status, 200);
    // Already confirmed, or unknown: same answer, no email.
    const confirmed = await api("POST", "/auth/verification-email", { email });
    const unknown = await api("POST", "/auth/verification-email", { email: `${unique("nobody")}@test.cm` });
    assert.deepEqual([confirmed.status, unknown.status], [202, 202]);
    assert.equal(confirmed.body.message, unknown.body.message);
    assert.equal(emailsTo(email).length, 2);
  });

  test("an expired link does not work", async () => {
    const { email } = await register();
    const token = linkIn(emailsTo(email)[0], "verify-email");
    await sql.query("update medichain_email_tokens set expires_at = now() - interval '1 minute' where purpose = 'VERIFY_EMAIL' and used_at is null");
    assert.equal((await api("POST", "/auth/verify-email", { token })).status, 400);
    const { rows } = await sql.query("select count(*)::int as n from medichain_email_tokens where token_hash = $1", [token]);
    assert.equal(rows[0].n, 0, "only the hash of a link is stored");
  });

  test("one address receives at most 3 emails an hour", async () => {
    const { email } = await register();
    for (let i = 0; i < 2; i++) assert.equal((await api("POST", "/auth/verification-email", { email })).status, 202);
    assert.equal((await api("POST", "/auth/verification-email", { email })).status, 202);
    assert.equal((await api("POST", "/auth/verification-email", { email })).status, 429);
  });
});

describe("password reset by email", () => {
  test("the link sets a new password once and signs out every session", async () => {
    const { email } = await register("en");
    assert.equal((await api("POST", "/auth/verify-email", { token: linkIn(emailsTo(email)[0], "verify-email") })).status, 200);
    const before = (await api("POST", "/auth/login", { email, password: PASSWORD })).body.token;
    const asked = await api("POST", "/auth/password-reset-requests", { email });
    assert.equal(asked.status, 202);
    const message = emailsTo(email).at(-1);
    assert.match(message.subject, /Reset your password/);
    const token = linkIn(message, "reset-password");
    assert.equal((await api("POST", "/auth/reset-password", { token, newPassword: "short" })).status, 400);
    const changed = await api("POST", "/auth/reset-password", { token, newPassword: "New-horse-battery-7" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await api("GET", "/auth/me", undefined, { token: before })).status, 401);
    assert.equal((await api("POST", "/auth/login", { email, password: PASSWORD })).status, 401);
    assert.equal((await api("POST", "/auth/login", { email, password: "New-horse-battery-7" })).status, 200);
    assert.equal((await api("POST", "/auth/reset-password", { token, newPassword: "Another-horse-8" })).status, 400);
    // No administrator request is created when email is set up.
    const { rows } = await sql.query("select count(*)::int as n from medichain_password_reset_requests where email = $1", [email]);
    assert.equal(rows[0].n, 0);
  });

  test("an unknown email gets the same answer and no email", async () => {
    const count = sent.length;
    const unknown = await api("POST", "/auth/password-reset-requests", { email: `${unique("nobody")}@test.cm` });
    assert.equal(unknown.status, 202);
    assert.match(unknown.body.message, /If an account exists/);
    assert.equal(sent.length, count);
  });

  test("resetting the password also confirms an address that was waiting for confirmation", async () => {
    const { email } = await register();
    await api("POST", "/auth/password-reset-requests", { email });
    const token = linkIn(emailsTo(email).at(-1), "reset-password");
    assert.equal((await api("POST", "/auth/reset-password", { token, newPassword: "New-horse-battery-7" })).status, 200);
    assert.equal((await api("POST", "/auth/login", { email, password: "New-horse-battery-7" })).status, 200);
  });
});
