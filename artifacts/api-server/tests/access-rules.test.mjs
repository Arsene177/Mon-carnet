// Access-rule tests: who can see and change which patient data.
//
// Runs the built API server against a dedicated, disposable Postgres database:
//   TEST_DATABASE_URL=postgres://…/moncarnet_test pnpm --filter @workspace/db run push   (with DATABASE_URL set to the same URL)
//   TEST_DATABASE_URL=postgres://…/moncarnet_test pnpm --filter @workspace/api-server run test
// Every run empties the Mon carnet tables, so the database name must contain "test".
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL || !/test/i.test(new URL(DATABASE_URL).pathname)) {
  throw new Error("Set TEST_DATABASE_URL to a disposable database whose name contains \"test\"; it is emptied on every run.");
}
const PORT = 5400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/api`;
const PASSWORD = "Correct-horse-9";
const TERMS_VERSION = "2026-11-draft-1";

const sql = new pg.Pool({ connectionString: DATABASE_URL });
let server;

// Stand-in for the storage sidecar and bucket, so uploads can be checked end to end.
const storedObjects = new Map();
let storage;
function startFakeStorage() {
  return new Promise((resolve) => {
    storage = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (req.url === "/object-storage/signed-object-url") {
        const { bucket_name, object_name } = JSON.parse(body.toString());
        res.end(JSON.stringify({ signed_url: `http://127.0.0.1:${storage.address().port}/o/${bucket_name}/${object_name}` }));
        return;
      }
      const key = decodeURIComponent(req.url.slice(3));
      if (req.method === "PUT") { storedObjects.set(key, body); res.end(); return; }
      if (req.method === "DELETE") { storedObjects.delete(key); res.statusCode = 204; res.end(); return; }
      const data = storedObjects.get(key);
      if (!data) { res.statusCode = 404; res.end(); return; }
      const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      if (range) {
        const end = Math.min(Number(range[2]), data.length - 1);
        res.writeHead(206, { "content-range": `bytes ${range[1]}-${end}/${data.length}`, "content-length": String(end - Number(range[1]) + 1) });
        res.end(data.subarray(Number(range[1]), end + 1));
        return;
      }
      res.end(data);
    }).listen(0, "127.0.0.1", resolve);
  });
}

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
const allowCodeReuse = (email) => sql.query("update medichain_users set mfa_last_used_step = null where email = $1", [email]);

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
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$${salt}$${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
  const { rows } = await sql.query(
    `insert into medichain_users (email, password_hash, role, name, hospital_name, professional_medical_number, doctor_verified, contact_info, terms_version, terms_accepted_at)
     values ($1, $2, $3, $4, $5, $6, $7, '+237677000000', $8, now()) returning id`,
    [email, hash, role, name ?? `${role} ${unique("")}`, role === "ADMIN" ? null : "Hôpital Laquintinie", role === "ADMIN" ? null : "ONMC-1234", verified, TERMS_VERSION],
  );
  const token = await login(email);
  // Doctors and administrators must use two-step sign-in before they can do anything else.
  if (!mfa || role === "PENDING_DOCTOR" || role === "PATIENT") return { id: rows[0].id, email, token };
  return { id: rows[0].id, email, token: (await enableMfa(email, token)).token };
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
  await startFakeStorage();
  const { rows } = await sql.query("select tablename from pg_tables where schemaname = 'public' and tablename like 'medichain\\_%' and tablename <> 'medichain_disease_codes'");
  if (rows.length) await sql.query(`truncate ${rows.map((row) => `"${row.tablename}"`).join(", ")} restart identity cascade`);

  server = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env, DATABASE_URL, PORT: String(PORT), JWT_SECRET: randomBytes(24).toString("hex"), NODE_ENV: "test", TRUST_PROXY: "1", LOG_LEVEL: "warn",
      PRIVATE_OBJECT_DIR: "/test-bucket/private", OBJECT_STORAGE_SIDECAR_URL: `http://127.0.0.1:${storage.address().port}`,
    },
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
  storage?.close();
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
    assert.equal((await api("GET", "/auth/me", { token: patient.token })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: changed.body.token })).status, 200);
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

  test("a token whose session version was changed is refused", async () => {
    const patient = await registerPatient();
    const [header, payload] = patient.token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    assert.equal(claims.sv, 0);
    const forged = `${header}.${Buffer.from(JSON.stringify({ ...claims, sv: 1 })).toString("base64url")}.${patient.token.split(".")[2]}`;
    assert.equal((await api("GET", "/auth/me", { token: forged })).status, 401);
  });
});

describe("security review fixes (OWASP ASVS)", () => {
  test("signing out ends that session on the server, and only that one", async () => {
    const patient = await registerPatient();
    const otherDevice = await login(patient.email);
    assert.equal((await api("POST", "/auth/sign-out", { token: patient.token })).status, 204);
    assert.equal((await api("GET", "/auth/me", { token: patient.token })).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: otherDevice })).status, 200);
  });

  test("sessions last 12 hours at most", async () => {
    const patient = await registerPatient();
    const claims = JSON.parse(Buffer.from(patient.token.split(".")[1], "base64url").toString("utf8"));
    assert.equal(claims.exp - claims.iat, 12 * 60 * 60);
    assert.ok(claims.jti, "each token has its own id");
  });

  test("new passwords: at least 12 characters, not common, not built from the account's details", async () => {
    const attempt = (overrides) => api("POST", "/auth/register", {
      body: { name: "Brigitte Essomba", email: `${unique("brigitte")}@test.cm`, role: "PATIENT", sex: "FEMALE", dateOfBirth: "1990-04-12", contactInfo: "+237 691 23 45 67", acceptedTermsVersion: TERMS_VERSION, healthDataConsent: true, ...overrides },
    });
    for (const password of ["Short-pw-9", "password1234", "Password2024!", "azertyuiop123", "aaaaaaaaaaaaaa", "Brigitte-2026-ok", "mon-691234567-code"]) {
      const result = await attempt({ password });
      assert.equal(result.status, 400, `${password} should be refused`);
    }
    assert.equal((await attempt({ password: "Le manguier fleurit en mars" })).status, 201);
    const patient = await registerPatient();
    const change = await api("POST", "/auth/change-password", { token: patient.token, body: { currentPassword: PASSWORD, newPassword: "qwertyuiop12" } });
    assert.equal(change.status, 400);
  });

  test("a temporary password must be replaced before anything else, and expires", async () => {
    const patient = await registerPatient();
    const admin = await createStaff("ADMIN");
    await api("POST", "/auth/password-reset-requests", { body: { email: patient.email } });
    const { rows: [request] } = await sql.query("select id from medichain_password_reset_requests where email = $1 and resolved_at is null", [patient.email]);
    const { body: { temporaryPassword } } = await api("POST", `/admin/password-reset-requests/${request.id}/reset`, { token: admin.token });
    const signedIn = await api("POST", "/auth/login", { body: { email: patient.email, password: temporaryPassword } });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.user.mustChangePassword, true);
    const blocked = await api("GET", "/patient/profile", { token: signedIn.body.token });
    assert.deepEqual([blocked.status, blocked.body.code], [403, "PASSWORD_CHANGE_REQUIRED"]);
    const changed = await api("POST", "/auth/change-password", { token: signedIn.body.token, body: { currentPassword: temporaryPassword, newPassword: "Un nouveau mot de passe 7" } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await api("GET", "/patient/profile", { token: changed.body.token })).status, 200);

    // An unused temporary password stops working after its expiry.
    await api("POST", "/auth/password-reset-requests", { body: { email: patient.email } });
    const { rows: [again] } = await sql.query("select id from medichain_password_reset_requests where email = $1 and resolved_at is null", [patient.email]);
    const second = (await api("POST", `/admin/password-reset-requests/${again.id}/reset`, { token: admin.token })).body.temporaryPassword;
    await sql.query("update medichain_users set password_expires_at = now() - interval '1 minute' where id = $1", [patient.id]);
    assert.equal((await api("POST", "/auth/login", { body: { email: patient.email, password: second } })).status, 401);
  });

  test("an upload is only accepted when the stored file really is the declared type and size", async () => {
    const patient = await registerPatient();
    const doctor = await createStaff("DOCTOR");
    assert.equal((await openBooklet(doctor, patient)).status, 200);
    const upload = async (bytes, declaredSize = bytes.length) => {
      const reserved = await api("POST", `/doctor/patient/${patient.id}/attachments/upload-url`, { token: doctor.token, body: { fileName: "result.pdf", contentType: "application/pdf", size: declaredSize } });
      assert.equal(reserved.status, 201, JSON.stringify(reserved.body));
      await fetch(reserved.body.uploadURL, { method: "PUT", body: bytes });
      return api("POST", `/doctor/patient/${patient.id}/attachments/${reserved.body.attachmentId}/complete`, { token: doctor.token });
    };
    const fakePdf = Buffer.from("<html><script>alert(1)</script></html>");
    const before = storedObjects.size;
    assert.equal((await upload(fakePdf)).status, 400, "an HTML file declared as PDF is refused");
    assert.equal(storedObjects.size, before, "the refused file is deleted from storage");
    const realPdf = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");
    assert.equal((await upload(realPdf, realPdf.length + 500)).status, 400, "a size that does not match is refused");
    assert.equal((await upload(realPdf)).status, 200);
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

  test("a recovery code works once, and the secret is stored encrypted", async () => {
    const patient = await registerPatient();
    const { recoveryCodes } = await enableMfa(patient.email, patient.token);
    assert.equal(recoveryCodes.length, 10);
    const [row] = (await sql.query("select mfa_secret from medichain_users where id = $1", [patient.id])).rows;
    assert.ok(!row.mfa_secret.includes(mfaSecrets.get(patient.email)));
    const useCode = () => api("POST", "/auth/login", { body: { email: patient.email, password: PASSWORD, code: recoveryCodes[0].toUpperCase() } });
    assert.equal((await useCode()).status, 200);
    assert.equal((await useCode()).status, 401);
    const status = await api("GET", "/auth/mfa", { token: await login(patient.email) });
    assert.equal(status.body.recoveryCodesRemaining, 9);
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
