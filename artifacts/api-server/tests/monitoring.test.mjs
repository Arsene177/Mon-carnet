// Monitoring: the readiness check, security events, and the alerts administrators receive.
// Runs its own API server with a stand-in alert webhook and a low unusual-access threshold.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DATABASE_URL, insertStaff, serverEnv } from "./supabase-test-env.mjs";
const PORT = 6300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api`;
const PASSWORD = "Correct-horse-9";
const TERMS = "2026-11-draft-1";
const sql = new pg.Pool({ connectionString: DATABASE_URL });
let server;
let webhook;
const alerts = [];
let ipCounter = 1;
const newIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function api(method, path, { token, body, ip = newIp() } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
}

function totp(secret, offset = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const at = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

let counter = 0;
const unique = (prefix) => `${prefix}${Date.now().toString(36)}${counter++}`;

async function registerPatient() {
  const email = `${unique("mon-patient")}@test.cm`;
  const { status, body } = await api("POST", "/auth/register", {
    body: { name: `Patient ${unique("")}`, email, password: PASSWORD, role: "PATIENT", sex: "FEMALE", dateOfBirth: "1990-04-12", contactInfo: "+237690000000", acceptedTermsVersion: TERMS, healthDataConsent: true },
  });
  assert.equal(status, 201, JSON.stringify(body));
  const { rows: [row] } = await sql.query("select id, patient_display_id from medichain_users where email = $1", [email]);
  return { id: row.id, email, token: body.token, cmId: row.patient_display_id };
}

/** An approved doctor or administrator with two-step sign-in on. */
async function createStaff(role, name) {
  const email = `${unique(`mon-${role.toLowerCase()}`)}@test.cm`;
  const id = await insertStaff(sql, { email, password: PASSWORD, role, name, terms: TERMS });
  const signedIn = await api("POST", "/auth/login", { body: { email, password: PASSWORD } });
  const setup = await api("POST", "/auth/mfa/setup", { token: signedIn.body.token, body: { password: PASSWORD } });
  const enabled = await api("POST", "/auth/mfa/enable", { token: signedIn.body.token, body: { code: totp(setup.body.secret) } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  return { id, email, name, token: enabled.body.token };
}

const eventsOfType = async (type) => (await sql.query("select * from medichain_security_events where type = $1 order by id", [type])).rows;
const inbox = async (userId) => (await sql.query("select title, body from medichain_notifications where recipient_id = $1 order by id", [userId])).rows;
const waitFor = async (check) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

before(async () => {
  await sql.query("delete from medichain_security_events");
  // Earlier test files leave administrators behind; only this file's administrators should be alerted.
  await sql.query("update medichain_users set is_active = false where role = 'ADMIN'");
  await new Promise((resolve) => {
    webhook = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      alerts.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end("ok");
    }).listen(0, "127.0.0.1", resolve);
  });
  server = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: serverEnv(PORT, {
      LOG_LEVEL: "error",
      ALERT_WEBHOOK_URL: `http://127.0.0.1:${webhook.address().port}/alert`,
      UNUSUAL_ACCESS_PATIENTS_PER_HOUR: "2",
    }),
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The API server did not start.");
});

after(async () => {
  server?.kill();
  webhook?.close();
  await sql.end();
});

describe("monitoring", () => {
  test("the readiness check confirms the database answers", async () => {
    const ready = await api("GET", "/readyz");
    assert.deepEqual([ready.status, ready.body], [200, { status: "ok", database: "ok" }]);
  });

  test("a locked account is recorded once and alerts administrators without naming the account", async () => {
    const admin = await createStaff("ADMIN", "Nadia Admin");
    const patient = await registerPatient();
    const ip = newIp();
    for (let attempt = 0; attempt < 5; attempt++) {
      await api("POST", "/auth/login", { ip, body: { email: patient.email, password: "wrong-password" } });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await api("POST", "/auth/login", { ip, body: { email: patient.email, password: "wrong-password" } })).status, 429);
    }
    await waitFor(async () => (await eventsOfType("ACCOUNT_LOCKED")).length > 0 && alerts.length > 0);
    const events = await eventsOfType("ACCOUNT_LOCKED");
    assert.equal(events.length, 1, "repeated blocked attempts are recorded once");
    assert.equal(events[0].details.email, patient.email);
    const alert = alerts.find((entry) => entry.type === "ACCOUNT_LOCKED");
    assert.ok(alert, "webhook received the alert");
    assert.equal(JSON.stringify(alert).includes(patient.email), false, "the alert does not contain the email");
    await waitFor(async () => (await inbox(admin.id)).length > 0);
    const [notice] = await inbox(admin.id);
    assert.match(notice.title, /Alerte de sécurité|Security alert/);
    assert.equal(notice.body.includes(patient.email), false);
  });

  test("a doctor opening many patients' records in an hour is reported", async () => {
    const doctor = await createStaff("DOCTOR", "Jean Mbarga");
    for (let index = 0; index < 2; index++) {
      const patient = await registerPatient();
      assert.equal((await api("POST", "/doctor/patient-access", { token: doctor.token, body: { patientDisplayId: patient.cmId } })).status, 200);
      assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: doctor.token })).status, 200);
    }
    await waitFor(async () => (await eventsOfType("UNUSUAL_RECORD_ACCESS")).length > 0);
    const [event] = await eventsOfType("UNUSUAL_RECORD_ACCESS");
    assert.ok(event, "unusual access recorded");
    assert.equal(event.user_id, doctor.id);
    assert.equal(event.details.patients, 2);
  });

  test("sensitive administrator actions are recorded and other administrators are told", async () => {
    const actor = await createStaff("ADMIN", "Acting Admin");
    const colleague = await createStaff("ADMIN", "Colleague Admin");
    const doctor = await createStaff("DOCTOR", "Reset Me");
    assert.equal((await api("POST", `/admin/users/${doctor.id}/mfa/reset`, { token: actor.token })).status, 200);
    const [event] = await eventsOfType("MFA_RESET_BY_ADMIN");
    assert.equal(event.details.adminName, "Acting Admin");
    assert.equal(event.details.accountName, "Reset Me");
    await waitFor(async () => (await inbox(colleague.id)).some((n) => /deux étapes|two-step/.test(n.body)));
    assert.ok((await inbox(colleague.id)).some((n) => /deux étapes|two-step/.test(n.body)), "the other administrator is told");
    assert.equal((await inbox(actor.id)).some((n) => /deux étapes|two-step/.test(n.body)), false, "the acting administrator is not told about their own action");
  });

  test("erasing an account leaves no name in the security log", async () => {
    const admin = await createStaff("ADMIN", "Erasing Admin");
    const patient = await registerPatient();
    assert.equal((await api("POST", "/account/deletion-request", { token: patient.token, body: { password: PASSWORD, reason: null } })).status, 201);
    const { rows: [request] } = await sql.query("select id from medichain_account_deletion_requests where user_id = $1", [patient.id]);
    const { rows: [user] } = await sql.query("select name from medichain_users where id = $1", [patient.id]);
    assert.equal((await api("POST", `/admin/deletion-requests/${request.id}/resolve`, { token: admin.token, body: { action: "ERASE", note: null } })).status, 200);
    const [event] = await eventsOfType("ACCOUNT_ERASED");
    assert.ok(event);
    assert.equal(JSON.stringify(event.details).includes(user.name), false);
  });

  test("only administrators can read security events", async () => {
    const admin = await createStaff("ADMIN", "Reading Admin");
    const doctor = await createStaff("DOCTOR", "Curious Doctor");
    const list = await api("GET", "/admin/security-events", { token: admin.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.some((event) => event.type === "ACCOUNT_LOCKED"));
    assert.equal((await api("GET", "/admin/security-events", { token: doctor.token })).status, 403);
  });
});
