// Access-rule tests: who can see and change which patient data.
//
// Runs the built API server against a local Supabase stack (see tests/supabase-test-env.mjs and
// docs/supabase.md). Every run empties the app's tables and deletes every sign-in.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DATABASE_URL, SUPABASE_URL, allowCodeReuse as allowCodeReuseFor, createAuthUser, insertStaff, resetDatabase, serverEnv } from "./supabase-test-env.mjs";
const PORT = 5400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/api`;
const PASSWORD = "Correct-horse-9";
const TERMS_VERSION = "2026-11-draft-1";

const sql = new pg.Pool({ connectionString: DATABASE_URL });
let server;

// Each caller gets its own address so per-address rate limits do not interfere between tests.
let ipCounter = 1;
const newIp = () => `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function api(method, path, { token, body, ip = newIp() } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
}

// Authenticator-app secrets of the test accounts that turned on two-step sign-in, by email.
const mfaSecrets = new Map();

/** The 6-digit code an authenticator app would show (RFC 6238, SHA-1, 30 s). */
function totp(secret, offsetSteps = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offsetSteps));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Lets a test sign in again within the same 30 seconds, which a real code cannot do. */
const allowCodeReuse = (email) => allowCodeReuseFor(sql, email);

const login = async (email) => {
  let { status, body } = await api("POST", "/auth/login", { body: { email, password: PASSWORD } });
  if (status === 200 && body.mfaRequired) {
    await allowCodeReuse(email);
    ({ status, body } = await api("POST", "/auth/login", { body: { email, password: PASSWORD, code: totp(mfaSecrets.get(email)) } }));
  }
  assert.equal(status, 200, `login ${email}: ${JSON.stringify(body)}`);
  return body.token;
};

/** Turns on two-step sign-in and returns the new token and recovery codes. */
async function enableMfa(email, token) {
  const setup = await api("POST", "/auth/mfa/setup", { token, body: { password: PASSWORD } });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  mfaSecrets.set(email, setup.body.secret);
  const enabled = await api("POST", "/auth/mfa/enable", { token, body: { code: totp(setup.body.secret) } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  return enabled.body;
}

let counter = 0;
const unique = (prefix) => `${prefix}${Date.now().toString(36)}${counter++}`;

async function registerPatient(overrides = {}) {
  const email = `${unique("patient")}@test.cm`;
  const { status, body } = await api("POST", "/auth/register", {
    body: {
      name: overrides.name ?? `Patient ${unique("")}`,
      email,
      password: PASSWORD,
      role: "PATIENT",
      sex: "FEMALE",
      dateOfBirth: "1990-04-12",
      contactInfo: "+237690000000",
      acceptedTermsVersion: TERMS_VERSION,
      healthDataConsent: true,
      ...overrides,
    },
  });
  assert.equal(status, 201, JSON.stringify(body));
  const [row] = (await sql.query("select id, patient_display_id from medichain_users where email = $1", [email])).rows;
  return { id: row.id, email, token: body.token, cmId: () => currentCmId(row.id) };
}

async function currentCmId(userId) {
  return (await sql.query("select patient_display_id from medichain_users where id = $1", [userId])).rows[0].patient_display_id;
}

/** Doctors and admins are inserted directly, as an administrator would have approved them. */
async function createStaff(role, { verified = true, name, mfa = true } = {}) {
  const email = `${unique(role.toLowerCase())}@test.cm`;
  const id = await insertStaff(sql, { email, password: PASSWORD, role, name: name ?? `${role} ${unique("")}`, terms: TERMS_VERSION, verified });
  const token = await login(email);
  // Doctors and administrators must use two-step sign-in before they can do anything else.
  if (!mfa || role === "PENDING_DOCTOR" || role === "PATIENT") return { id, email, token };
  return { id, email, token: (await enableMfa(email, token)).token };
}

const consultation = {
  recordType: "Consultation",
  diagnosis: "Paludisme simple",
  treatment: "ACT 3 jours",
  medications: ["Artemether-lumefantrine"],
  notes: "",
  vitals: { bloodPressure: "120/80", heartRate: 80, temperature: 38.4, weightKg: 61 },
  followUpToRecordId: null,
  attachmentIds: [],
  codedDiagnoses: [],
};

async function openBooklet(doctor, patient) {
  return api("POST", "/doctor/patient-access", { token: doctor.token, body: { patientDisplayId: await patient.cmId() } });
}

before(async () => {
  await resetDatabase(sql);

  server = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: serverEnv(PORT),
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
  await sql.end();
});

describe("authentication and roles", () => {
  test("patient data needs a signed-in patient", async () => {
    assert.equal((await api("GET", "/patient/records")).status, 401);
    assert.equal((await api("GET", "/patient/records", { token: "not-a-token" })).status, 401);
    const doctor = await createStaff("DOCTOR");
    assert.equal((await api("GET", "/patient/records", { token: doctor.token })).status, 403);
  });

  test("patients cannot use doctor or administrator endpoints", async () => {
    const patient = await registerPatient();
    assert.equal((await api("POST", "/doctor/patient-access", { token: patient.token, body: { patientDisplayId: await patient.cmId() } })).status, 403);
    assert.equal((await api("GET", "/admin/stats", { token: patient.token })).status, 403);
    assert.equal((await api("GET", "/admin/possible-duplicates", { token: patient.token })).status, 403);
  });

  test("a doctor awaiting approval cannot open booklets", async () => {
    const patient = await registerPatient();
    const pending = await createStaff("PENDING_DOCTOR");
    assert.equal((await openBooklet(pending, patient)).status, 403);
  });

  test("a suspended doctor's existing session stops working", async () => {
    const doctor = await createStaff("DOCTOR");
    const admin = await createStaff("ADMIN");
    assert.equal((await api("PUT", `/admin/users/${doctor.id}/status`, { token: admin.token, body: { isActive: false } })).status, 200);
    assert.equal((await api("GET", "/auth/me", { token: doctor.token })).status, 401);
  });

  test("an account is locked after five wrong passwords", async () => {
    const patient = await registerPatient();
    const ip = newIp();
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await api("POST", "/auth/login", { ip, body: { email: patient.email, password: "wrong-password" } })).status, 401);
    }
    assert.equal((await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD } })).status, 429);
  });
});

describe("sessions", () => {
  test("changing the password signs out every other session, and this device keeps working", async () => {
    const patient = await registerPatient();
    const otherDevice = await login(patient.email);
    const changed = await api("POST", "/auth/change-password", {
      token: patient.token,
      body: { currentPassword: PASSWORD, newPassword: "New-horse-battery-7" },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await api("GET", "/auth/me", { token: otherDevice })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: patient.token })).status, 200);
    assert.equal((await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD } })).status, 401);
    assert.equal((await api("POST", "/auth/login", { body: { email: patient.email, password: "New-horse-battery-7" } })).status, 200);
  });

  test("signing out of other devices ends their sessions only", async () => {
    const doctor = await createStaff("DOCTOR");
    const otherDevice = await login(doctor.email);
    const result = await api("POST", "/auth/sign-out-other-devices", { token: doctor.token });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await api("GET", "/auth/me", { token: otherDevice })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: result.body.token })).status, 200);
    // Signing in again afterwards works as usual.
    assert.equal((await api("GET", "/auth/me", { token: await login(doctor.email) })).status, 200);
    const { rows } = await sql.query("select count(*)::int as n from medichain_audit_events where actor_user_id = $1 and action = 'OTHER_SESSIONS_SIGNED_OUT'", [doctor.id]);
    assert.equal(rows[0].n, 1);
  });

  test("a temporary password from an administrator signs out every existing session", async () => {
    const patient = await registerPatient();
    const admin = await createStaff("ADMIN");
    assert.equal((await api("POST", "/auth/password-reset-requests", { body: { email: patient.email } })).status, 202);
    const { rows } = await sql.query("select id from medichain_password_reset_requests where email = $1", [patient.email]);
    const reset = await api("POST", `/admin/password-reset-requests/${rows[0].id}/reset`, { token: admin.token });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal((await api("GET", "/auth/me", { token: patient.token })).status, 401);
    const signedIn = await api("POST", "/auth/login", { body: { email: patient.email, password: reset.body.temporaryPassword } });
    assert.equal(signedIn.status, 200);
  });

  test("a changed token is refused, and signing out ends the session on the server at once", async () => {
    const patient = await registerPatient();
    const [header, payload, signature] = patient.token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forged = `${header}.${Buffer.from(JSON.stringify({ ...claims, aal: "aal2", sub: claims.sub })).toString("base64url")}.${signature}`;
    assert.equal((await api("GET", "/auth/me", { token: forged })).status, 401);
    const other = await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD } });
    assert.equal((await api("POST", "/auth/sign-out", { token: patient.token })).status, 204);
    assert.equal((await api("GET", "/auth/me", { token: patient.token })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: other.body.token })).status, 200);
  });

  test("a refresh token renews the session, and stops working once the account is suspended", async () => {
    const patient = await registerPatient();
    const signedIn = await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD } });
    const renewed = await api("POST", "/auth/refresh", { body: { refreshToken: signedIn.body.refreshToken } });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.ok(renewed.body.refreshToken && renewed.body.expiresAt);
    assert.equal((await api("GET", "/auth/me", { token: renewed.body.token })).status, 200);
    const admin = await createStaff("ADMIN");
    assert.equal((await api("PUT", `/admin/users/${patient.id}/status`, { token: admin.token, body: { isActive: false } })).status, 200);
    assert.equal((await api("POST", "/auth/refresh", { body: { refreshToken: renewed.body.refreshToken } })).status, 401);
    assert.equal((await api("POST", "/auth/refresh", { body: { refreshToken: "not-a-token" } })).status, 401);
  });
});

describe("two-step sign-in", () => {
  test("doctors and administrators can do nothing but set it up until it is on", async () => {
    const doctor = await createStaff("DOCTOR", { mfa: false });
    const admin = await createStaff("ADMIN", { mfa: false });
    const patient = await registerPatient();
    const blocked = await openBooklet(doctor, patient);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "MFA_SETUP_REQUIRED");
    assert.equal((await api("GET", "/admin/stats", { token: admin.token })).status, 403);
    const me = await api("GET", "/auth/me", { token: doctor.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.mfaRequired, true);
    assert.equal(me.body.mfaEnabled, false);
    const { token } = await enableMfa(doctor.email, doctor.token);
    assert.equal((await openBooklet({ ...doctor, token }, patient)).status, 200);
  });

  test("turning it on signs out sessions that used only the password", async () => {
    const patient = await registerPatient();
    const otherDevice = await login(patient.email);
    const { token } = await enableMfa(patient.email, patient.token);
    assert.equal((await api("GET", "/auth/me", { token: otherDevice })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token })).status, 200);
  });

  test("sign-in needs the password and then a code, and each code works once", async () => {
    const patient = await registerPatient();
    await enableMfa(patient.email, patient.token);
    const secret = mfaSecrets.get(patient.email);
    const first = await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD } });
    assert.deepEqual([first.status, first.body.mfaRequired, first.body.token], [200, true, undefined]);
    assert.equal((await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD, code: "000000" } })).status, 401);
    assert.equal((await api("POST", "/auth/login", { body: { email: patient.email, password: "wrong-password", code: totp(secret) } })).status, 401);
    // The code that turned it on was from this 30-second step, so use the next one.
    const code = totp(secret, 1);
    const signedIn = await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD, code } });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.ok(signedIn.body.token);
    assert.equal((await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD, code } })).status, 401);
  });

  test("a recovery code signs in once and removes the lost authenticator", async () => {
    const doctor = await createStaff("DOCTOR");
    const { rows: before } = await sql.query("select count(*)::int as n from medichain_mfa_recovery_codes where user_id = $1", [doctor.id]);
    assert.equal(before[0].n, 10);
    assert.equal((await api("POST", "/auth/login", { body: { email: doctor.email, password: PASSWORD, code: "abcd-efgh" } })).status, 401);
    // New recovery codes need a code from the app, not a recovery code.
    await allowCodeReuse(doctor.email);
    const fresh = await api("POST", "/auth/mfa/recovery-codes", { token: doctor.token, body: { password: PASSWORD, code: totp(mfaSecrets.get(doctor.email)) } });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal((await api("POST", "/auth/mfa/recovery-codes", { token: doctor.token, body: { password: PASSWORD, code: fresh.body.recoveryCodes[1] } })).status, 400);
    const signedIn = await api("POST", "/auth/login", { body: { email: doctor.email, password: PASSWORD, code: fresh.body.recoveryCodes[0].toUpperCase() } });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.equal(signedIn.body.authenticatorRemoved, true);
    assert.equal(signedIn.body.user.mfaEnabled, false);
    const { rows: factors } = await sql.query("select count(*)::int as n from auth.mfa_factors f join medichain_users u on u.auth_user_id = f.user_id where u.id = $1", [doctor.id]);
    assert.equal(factors[0].n, 0);
    const { rows: codes } = await sql.query("select count(*)::int as n from medichain_mfa_recovery_codes where user_id = $1", [doctor.id]);
    assert.equal(codes[0].n, 0);
    // A doctor must set it up again before anything else.
    const patient = await registerPatient();
    assert.equal((await openBooklet({ ...doctor, token: signedIn.body.token }, patient)).body.code, "MFA_SETUP_REQUIRED");
    // The app never stores the authenticator secret itself.
    const { rows: columns } = await sql.query("select column_name from information_schema.columns where table_name = 'medichain_users' and column_name like 'mfa%secret%'");
    assert.deepEqual(columns, []);
  });

  test("a password-only session from Supabase Auth is refused for an account with two-step sign-in on", async () => {
    const patient = await registerPatient();
    await enableMfa(patient.email, patient.token);
    // Someone with only the password signs in at Supabase Auth directly, skipping the app.
    const direct = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: process.env.SUPABASE_SECRET_KEY, "content-type": "application/json" },
      body: JSON.stringify({ email: patient.email, password: PASSWORD }),
    });
    const session = await direct.json();
    assert.equal(direct.status, 200);
    assert.equal((await api("GET", "/patient/records", { token: session.access_token })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: session.access_token })).status, 401);
  });

  test("patients can turn it off; doctors cannot", async () => {
    const patient = await registerPatient();
    const { token } = await enableMfa(patient.email, patient.token);
    await allowCodeReuse(patient.email);
    const off = await api("POST", "/auth/mfa/disable", { token, body: { password: PASSWORD, code: totp(mfaSecrets.get(patient.email)) } });
    assert.equal(off.status, 204, JSON.stringify(off.body));
    assert.equal((await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD } })).body.mfaRequired, false);
    const doctor = await createStaff("DOCTOR");
    await allowCodeReuse(doctor.email);
    assert.equal((await api("POST", "/auth/mfa/disable", { token: doctor.token, body: { password: PASSWORD, code: totp(mfaSecrets.get(doctor.email)) } })).status, 403);
  });

  test("an administrator can reset another account's two-step sign-in, which signs it out", async () => {
    const doctor = await createStaff("DOCTOR");
    const admin = await createStaff("ADMIN");
    assert.equal((await api("POST", `/admin/users/${admin.id}/mfa/reset`, { token: admin.token })).status, 400);
    assert.equal((await api("POST", `/admin/users/${doctor.id}/mfa/reset`, { token: doctor.token })).status, 403);
    const reset = await api("POST", `/admin/users/${doctor.id}/mfa/reset`, { token: admin.token });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.mfaEnabled, false);
    assert.equal((await api("GET", "/auth/me", { token: doctor.token })).status, 401);
    const { rows } = await sql.query("select count(*)::int as n from medichain_notifications where recipient_id = $1", [doctor.id]);
    assert.equal(rows[0].n, 1);
  });
});

describe("doctor access to a patient's records", () => {
  test("without a grant a doctor cannot read or add records", async () => {
    const patient = await registerPatient();
    const doctor = await createStaff("DOCTOR");
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: doctor.token })).status, 403);
    assert.equal((await api("POST", `/doctor/patient/${patient.id}/records`, { token: doctor.token, body: consultation })).status, 403);
  });

  test("automatic mode: the CM ID grants access until the patient revokes it, which also changes the CM ID", async () => {
    const patient = await registerPatient();
    const doctor = await createStaff("DOCTOR");
    const oldCmId = await patient.cmId();
    const opened = await openBooklet(doctor, patient);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.status, "GRANTED");
    assert.equal((await api("POST", `/doctor/patient/${patient.id}/records`, { token: doctor.token, body: consultation })).status, 201);
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: doctor.token })).status, 200);

    assert.equal((await api("DELETE", `/patient/permissions/${doctor.id}`, { token: patient.token })).status, 204);
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: doctor.token })).status, 403);
    assert.notEqual(await patient.cmId(), oldCmId);
    assert.equal((await api("POST", "/doctor/patient-access", { token: doctor.token, body: { patientDisplayId: oldCmId } })).status, 404);
  });

  test("ask-me-first mode: nothing opens until the patient approves", async () => {
    const patient = await registerPatient();
    const doctor = await createStaff("DOCTOR");
    assert.equal((await api("PUT", "/patient/access-settings", { token: patient.token, body: { accessApprovalMode: "ASK" } })).status, 200);

    const requested = await openBooklet(doctor, patient);
    assert.equal(requested.body.status, "PENDING");
    assert.equal(requested.body.patientNationalIdNumber, null);
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: doctor.token })).status, 403);

    const waiting = await api("GET", "/patient/access-requests", { token: patient.token });
    assert.equal(waiting.body.length, 1);
    const approved = await api("POST", `/patient/access-requests/${waiting.body[0].id}/approve`, { token: patient.token, body: { durationDays: 1 } });
    assert.equal(approved.status, 200);
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: doctor.token })).status, 200);

    // An expired grant no longer opens the booklet.
    await sql.query("update medichain_access_permissions set expires_at = now() - interval '1 minute' where patient_id = $1 and doctor_id = $2", [patient.id, doctor.id]);
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: doctor.token })).status, 403);
  });

  test("a rejected doctor must wait before asking again, and a patient cannot answer someone else's request", async () => {
    const patient = await registerPatient();
    const other = await registerPatient();
    const doctor = await createStaff("DOCTOR");
    await api("PUT", "/patient/access-settings", { token: patient.token, body: { accessApprovalMode: "ASK" } });
    await openBooklet(doctor, patient);
    const [request] = (await api("GET", "/patient/access-requests", { token: patient.token })).body;

    assert.equal((await api("POST", `/patient/access-requests/${request.id}/approve`, { token: other.token, body: { durationDays: null } })).status, 404);
    assert.equal((await api("POST", `/patient/access-requests/${request.id}/reject`, { token: patient.token })).status, 204);
    assert.equal((await openBooklet(doctor, patient)).status, 429);
  });

  test("an administrator cannot read medical records", async () => {
    const patient = await registerPatient();
    const admin = await createStaff("ADMIN");
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: admin.token })).status, 403);
    assert.equal((await api("GET", "/patient/records", { token: admin.token })).status, 403);
  });

  test("saved records cannot be edited or deleted", async () => {
    const patient = await registerPatient();
    const doctor = await createStaff("DOCTOR");
    await openBooklet(doctor, patient);
    const created = await api("POST", `/doctor/patient/${patient.id}/records`, { token: doctor.token, body: consultation });
    assert.equal(created.status, 201);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const response = await api(method, `/doctor/patient/${patient.id}/records/${created.body.id}`, { token: doctor.token, body: method === "DELETE" ? undefined : consultation });
      assert.ok([404, 405].includes(response.status), `${method} returned ${response.status}`);
    }
  });
});

describe("emergency lookup", () => {
  test("needs the full name and a reason, returns emergency details only, and tells the patient", async () => {
    const name = `Hélène ${unique("Mbarga")}`;
    const patient = await registerPatient({ name, nationalIdNumber: unique("CNI").toUpperCase().slice(0, 18) });
    await api("PUT", "/patient/emergency-info", { token: patient.token, body: { bloodGroup: "O+", weightKg: 60, heightCm: 165, allergies: "Pénicilline", emergencyContact: "+237699000000" } });
    const doctor = await createStaff("DOCTOR");
    const reason = "Patient inconscient aux urgences";

    assert.equal((await api("POST", "/doctor/emergency-lookup", { token: doctor.token, body: { fullName: name.split(" ")[0], dateOfBirth: null, reason } })).status, 400);
    assert.equal((await api("POST", "/doctor/emergency-lookup", { token: doctor.token, body: { fullName: name, dateOfBirth: null, reason: "" } })).status, 400);

    const reversed = name.split(" ").reverse().join(" ").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
    const found = await api("POST", "/doctor/emergency-lookup", { token: doctor.token, body: { fullName: reversed, dateOfBirth: null, reason } });
    assert.equal(found.status, 200);
    assert.equal(found.body.length, 1);
    const info = found.body[0].emergencyInfo;
    assert.equal(info.bloodGroup, "O+");
    assert.ok(!JSON.stringify(found.body).includes("CNI"), "the CNI number must not be returned");
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: doctor.token })).status, 403);

    const inbox = await api("GET", "/notifications", { token: patient.token });
    assert.ok(inbox.body.items.some((item) => item.body.includes(reason)));
  });
});

describe("identity data", () => {
  test("administrators never receive a patient's CNI number", async () => {
    const cni = unique("CE").toUpperCase().slice(0, 18);
    const patient = await registerPatient({ nationalIdNumber: cni });
    const admin = await createStaff("ADMIN");
    const search = await api("GET", `/admin/search-user?query=${encodeURIComponent(patient.email)}`, { token: admin.token });
    assert.equal(search.status, 200);
    assert.ok(!JSON.stringify(search.body).includes(cni));
    const directory = await api("GET", "/admin/directory?kind=PATIENTS", { token: admin.token });
    assert.ok(!JSON.stringify(directory.body).includes(cni));
  });

  test("a CNI number can belong to one account only", async () => {
    const cni = unique("CNI").toUpperCase().slice(0, 18);
    await registerPatient({ nationalIdNumber: cni });
    const second = await api("POST", "/auth/register", {
      body: { name: "Paul Essomba", email: `${unique("dup")}@test.cm`, password: PASSWORD, role: "PATIENT", sex: "MALE", dateOfBirth: "1980-01-01", contactInfo: "+237690000001", nationalIdNumber: cni, acceptedTermsVersion: TERMS_VERSION, healthDataConsent: true },
    });
    assert.equal(second.status, 409);
  });
});

describe("data rights", () => {
  test("the data export contains only the requester's own data", async () => {
    const patient = await registerPatient();
    const other = await registerPatient();
    const exported = await api("GET", "/account/data-export", { token: patient.token });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.account.email, patient.email);
    assert.ok(!JSON.stringify(exported.body).includes(other.email));
  });

  test("a closed account cannot sign in or be restored, and its records are kept", async () => {
    const patient = await registerPatient();
    const doctor = await createStaff("DOCTOR");
    const admin = await createStaff("ADMIN");
    await openBooklet(doctor, patient);
    await api("POST", `/doctor/patient/${patient.id}/records`, { token: doctor.token, body: consultation });
    assert.equal((await api("POST", "/account/deletion-request", { token: patient.token, body: { password: PASSWORD, reason: null } })).status, 201);
    const [request] = (await api("GET", "/admin/deletion-requests", { token: admin.token })).body.filter((row) => row.userId === patient.id);
    assert.equal((await api("POST", `/admin/deletion-requests/${request.id}/resolve`, { token: admin.token, body: { action: "CLOSE", note: null } })).status, 200);

    assert.equal((await api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD } })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: patient.token })).status, 401);
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/records`, { token: doctor.token })).status, 403);
    assert.equal((await api("PUT", `/admin/users/${patient.id}/status`, { token: admin.token, body: { isActive: true } })).status, 409);
    const { rows } = await sql.query("select count(*)::int as n from medichain_medical_records where patient_id = $1", [patient.id]);
    assert.equal(rows[0].n, 1);
  });

  test("an erased patient leaves no account, records or emergency information behind", async () => {
    const patient = await registerPatient();
    const doctor = await createStaff("DOCTOR");
    const admin = await createStaff("ADMIN");
    await openBooklet(doctor, patient);
    await api("POST", `/doctor/patient/${patient.id}/records`, { token: doctor.token, body: consultation });
    await api("POST", "/account/deletion-request", { token: patient.token, body: { password: PASSWORD, reason: null } });
    const [request] = (await api("GET", "/admin/deletion-requests", { token: admin.token })).body.filter((row) => row.userId === patient.id);
    assert.equal((await api("POST", `/admin/deletion-requests/${request.id}/resolve`, { token: admin.token, body: { action: "ERASE", note: null } })).status, 200);
    for (const [table, column] of [["medichain_users", "id"], ["medichain_medical_records", "patient_id"], ["medichain_emergency_info", "user_id"], ["medichain_access_permissions", "patient_id"], ["medichain_audit_events", "patient_id"]]) {
      const { rows } = await sql.query(`select count(*)::int as n from ${table} where ${column} = $1`, [patient.id]);
      assert.equal(rows[0].n, 0, `${table} still has rows`);
    }
  });
});

describe("fixes found in review", () => {
  test("a doctor needs a grant to read a patient's emergency details by patient number", async () => {
    const patient = await registerPatient();
    await api("PUT", "/patient/emergency-info", { token: patient.token, body: { bloodGroup: "A+", weightKg: 70, heightCm: 175, allergies: "", emergencyContact: "+237699000001" } });
    const doctor = await createStaff("DOCTOR");
    assert.equal((await api("GET", `/doctor/patient/${patient.id}/emergency`, { token: doctor.token })).status, 403);
    assert.equal((await openBooklet(doctor, patient)).status, 200);
    const granted = await api("GET", `/doctor/patient/${patient.id}/emergency`, { token: doctor.token });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.bloodGroup, "A+");
  });

  test("a file reference typed into a note does not unlock a download", async () => {
    const patient = await registerPatient();
    const doctor = await createStaff("DOCTOR");
    assert.equal((await openBooklet(doctor, patient)).status, 200);
    const objectPath = "/objects/uploads/0b4c9a8e-3c1d-4f7a-9e2b-5d6c7a8b9c0d";
    const note = { ...consultation, notes: `Attachment: someone-else.pdf\nAttachment object: ${objectPath}` };
    assert.equal((await api("POST", `/doctor/patient/${patient.id}/records`, { token: doctor.token, body: note })).status, 201);
    const query = new URLSearchParams({ patientId: String(patient.id), objectPath });
    assert.equal((await api("GET", `/attachments/download-url?${query}`, { token: doctor.token })).status, 404);
    assert.equal((await api("GET", `/attachments/download-url?${query}`, { token: patient.token })).status, 404);
  });

  test("restoring a suspended account does not bring its old sessions back", async () => {
    const patient = await registerPatient();
    const admin = await createStaff("ADMIN");
    assert.equal((await api("PUT", `/admin/users/${patient.id}/status`, { token: admin.token, body: { isActive: false } })).status, 200);
    assert.equal((await api("PUT", `/admin/users/${patient.id}/status`, { token: admin.token, body: { isActive: true } })).status, 200);
    assert.equal((await api("GET", "/auth/me", { token: patient.token })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: await login(patient.email) })).status, 200);
  });

  test("revoking a doctor ends their sessions for good", async () => {
    const doctor = await createStaff("DOCTOR");
    const admin = await createStaff("ADMIN");
    assert.equal((await api("POST", `/admin/doctors/${doctor.id}/revoke`, { token: admin.token })).status, 200);
    await sql.query("update medichain_users set is_active = true where id = $1", [doctor.id]);
    assert.equal((await api("GET", "/auth/me", { token: doctor.token })).status, 401);
  });

  test("administrator notices reach patients and doctors, not administrators", async () => {
    const patient = await registerPatient();
    const sender = await createStaff("ADMIN");
    const otherAdmin = await createStaff("ADMIN");
    const title = unique("Notice ");
    const sent = await api("POST", "/admin/notifications", { token: sender.token, body: { title, body: "Maintenance tonight.", targetType: "ALL" } });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const titles = async (token) => (await api("GET", "/notifications", { token })).body.items.map((item) => item.title);
    assert.ok((await titles(patient.token)).includes(title));
    assert.ok(!(await titles(otherAdmin.token)).includes(title));
    assert.ok(!(await titles(sender.token)).includes(title));
    const toAdmin = await api("POST", "/admin/notifications", { token: sender.token, body: { title, body: "x", targetType: "USERS", userIds: [otherAdmin.id] } });
    assert.equal(toAdmin.status, 400);
  });

  test("% and _ in a user search are matched literally", async () => {
    await registerPatient();
    const admin = await createStaff("ADMIN");
    const search = await api("GET", `/admin/search-user?query=${encodeURIComponent("%_")}`, { token: admin.token });
    assert.equal(search.status, 200);
    assert.equal(search.body.length, 0);
  });

  test("an estimated date of birth is stored as 1 January of that year", async () => {
    const patient = await registerPatient({ dateOfBirth: "1985-07-19", dateOfBirthEstimated: true });
    const { rows } = await sql.query("select date_of_birth::text as dob from medichain_users where id = $1", [patient.id]);
    assert.equal(rows[0].dob, "1985-01-01");
  });

  test("emergency lookup ignores accents and special letters such as ŋ and œ", async () => {
    const doctor = await createStaff("DOCTOR");
    const reason = "Patient inconscient aux urgences";
    const suffix = unique("").replace(/[^a-z0-9]/g, "");
    for (const [stored, typed] of [[`Ŋgọc Bœuf${suffix}`, `boeuf${suffix} ngoc`], [`Ÿvette Ōkala${suffix}`, `Yvette Okala${suffix}`]]) {
      const patient = await registerPatient({ name: stored });
      await api("PUT", "/patient/emergency-info", { token: patient.token, body: { bloodGroup: "B+", weightKg: 60, heightCm: 160, allergies: "", emergencyContact: "+237699000002" } });
      const found = await api("POST", "/doctor/emergency-lookup", { token: doctor.token, body: { fullName: typed, dateOfBirth: null, reason } });
      assert.equal(found.status, 200, JSON.stringify(found.body));
      assert.deepEqual(found.body.map((result) => result.emergencyInfo.patientId), [patient.id], `${typed} should find ${stored}`);
    }
  });

  test("wrong passwords and codes on signed-in account actions are limited per account", async () => {
    const patient = await registerPatient();
    const wrong = { currentPassword: "Not-my-password-1", newPassword: "Another-pass-22" };
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await api("POST", "/auth/change-password", { token: patient.token, body: wrong })).status, 400);
    }
    // The limit is shared between actions: wrong codes count too.
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await api("POST", "/auth/mfa/setup", { token: patient.token, body: { password: "Not-my-password-1" } })).status, 400);
    }
    const blocked = await api("POST", "/auth/change-password", { token: patient.token, body: { currentPassword: PASSWORD, newPassword: "Another-pass-22" } });
    assert.equal(blocked.status, 429);
    // Other accounts are not affected.
    const other = await registerPatient();
    assert.equal((await api("POST", "/auth/change-password", { token: other.token, body: { currentPassword: PASSWORD, newPassword: "Another-pass-22" } })).status, 200);
  });

  test("sign-in for an unknown email takes about as long as a wrong password", async () => {
    const patient = await registerPatient();
    const time = async (email) => {
      const start = performance.now();
      assert.equal((await api("POST", "/auth/login", { body: { email, password: "Wrong-password-1" } })).status, 401);
      return performance.now() - start;
    };
    await time(patient.email);
    const known = Math.min(await time(patient.email), await time(patient.email));
    const unknown = Math.min(await time(`${unique("nobody")}@test.cm`), await time(`${unique("nobody")}@test.cm`));
    // A password check takes tens of milliseconds; without one an unknown email answered several times faster.
    assert.ok(unknown > known * 0.5, `unknown ${unknown.toFixed(1)} ms vs known ${known.toFixed(1)} ms`);
  });
});

describe("Supabase", () => {
  test("the public key of the Supabase project reads nothing from the app's tables", async (t) => {
    const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!publicKey) return t.skip("SUPABASE_PUBLISHABLE_KEY is not set");
    await registerPatient();
    for (const table of ["medichain_users", "medichain_medical_records", "medichain_emergency_info", "medichain_mfa_recovery_codes"]) {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, { headers: { apikey: publicKey } });
      const body = await response.json();
      assert.ok(response.status === 401 || response.status === 403 || (Array.isArray(body) && body.length === 0), `${table}: ${response.status} ${JSON.stringify(body).slice(0, 120)}`);
    }
    const { rows } = await sql.query("select count(*)::int as n from pg_tables where schemaname = 'public' and tablename like 'medichain\\_%' and not rowsecurity");
    assert.equal(rows[0].n, 0, "every table has row-level security on");
  });

  test("an account copied from the previous database keeps its password, which moves to Supabase Auth on first sign-in", async () => {
    const email = `${unique("copied")}@test.cm`;
    const salt = randomBytes(16).toString("hex");
    const legacyHash = ["scrypt", salt, scryptSync(PASSWORD, salt, 64).toString("hex")].join("$");
    const authUserId = await createAuthUser(email);
    const { rows: [{ id }] } = await sql.query(
      `insert into medichain_users (email, auth_user_id, password_hash, role, name, sex, date_of_birth, contact_info, terms_version, terms_accepted_at, health_data_consent_at, patient_display_id, patient_access_id)
       values ($1, $2, $3, 'PATIENT', 'Copied Patient', 'MALE', '1980-02-03', '+237690000001', $4, now(), now(), $5, $5) returning id`,
      [email, authUserId, legacyHash, TERMS_VERSION, `CM${unique("").toUpperCase().slice(-6)}1A`],
    );
    assert.equal((await api("POST", "/auth/login", { body: { email, password: "Wrong-password-1" } })).status, 401);
    const first = await api("POST", "/auth/login", { body: { email, password: PASSWORD } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { rows: [row] } = await sql.query("select password_hash from medichain_users where id = $1", [id]);
    assert.equal(row.password_hash, null, "the old hash is cleared once the password has moved");
    assert.equal((await api("POST", "/auth/login", { body: { email, password: PASSWORD } })).status, 200);
  });

  test("closing an account deletes its Supabase sign-in", async () => {
    const patient = await registerPatient();
    const admin = await createStaff("ADMIN");
    assert.equal((await api("POST", "/account/deletion-request", { token: patient.token, body: { password: PASSWORD, reason: null } })).status, 201);
    const { rows: [request] } = await sql.query("select id from medichain_account_deletion_requests where user_id = $1", [patient.id]);
    const { rows: [before] } = await sql.query("select auth_user_id from medichain_users where id = $1", [patient.id]);
    assert.equal((await api("POST", `/admin/deletion-requests/${request.id}/resolve`, { token: admin.token, body: { action: "CLOSE", note: null } })).status, 200);
    const { rows: signIns } = await sql.query("select count(*)::int as n from auth.users where id = $1", [before.auth_user_id]);
    assert.equal(signIns[0].n, 0);
    assert.equal((await api("GET", "/auth/me", { token: patient.token })).status, 401);
  });
});
