// Access-rule tests: who can see and change which patient data.
//
// Runs the built API server against a dedicated, disposable Postgres database:
//   TEST_DATABASE_URL=postgres://…/moncarnet_test pnpm --filter @workspace/db run push   (with DATABASE_URL set to the same URL)
//   TEST_DATABASE_URL=postgres://…/moncarnet_test pnpm --filter @workspace/api-server run test
// Every run empties the Mon carnet tables, so the database name must contain "test".
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
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

const login = async (email) => {
  const { status, body } = await api("POST", "/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(status, 200, `login ${email}: ${JSON.stringify(body)}`);
  return body.token;
};

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
async function createStaff(role, { verified = true, name } = {}) {
  const email = `${unique(role.toLowerCase())}@test.cm`;
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$${salt}$${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
  const { rows } = await sql.query(
    `insert into medichain_users (email, password_hash, role, name, hospital_name, professional_medical_number, doctor_verified, contact_info, terms_version, terms_accepted_at)
     values ($1, $2, $3, $4, $5, $6, $7, '+237677000000', $8, now()) returning id`,
    [email, hash, role, name ?? `${role} ${unique("")}`, role === "ADMIN" ? null : "Hôpital Laquintinie", role === "ADMIN" ? null : "ONMC-1234", verified, TERMS_VERSION],
  );
  return { id: rows[0].id, email, token: await login(email) };
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
  const { rows } = await sql.query("select tablename from pg_tables where schemaname = 'public' and tablename like 'medichain\\_%' and tablename <> 'medichain_disease_codes'");
  if (rows.length) await sql.query(`truncate ${rows.map((row) => `"${row.tablename}"`).join(", ")} restart identity cascade`);

  server = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL, PORT: String(PORT), JWT_SECRET: randomBytes(24).toString("hex"), NODE_ENV: "test", TRUST_PROXY: "1", LOG_LEVEL: "warn" },
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
