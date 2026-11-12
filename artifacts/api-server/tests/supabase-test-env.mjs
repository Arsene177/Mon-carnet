// Shared set-up for tests that run the API server against a local Supabase stack
// (`supabase start` from the repository root; see docs/supabase.md).
//
//   TEST_DATABASE_URL     the local Supabase database, e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres
//   SUPABASE_URL          the local API, e.g. http://127.0.0.1:54321
//   SUPABASE_SECRET_KEY   the local secret key (`supabase status -o env`, SECRET_KEY)
//   SUPABASE_JWT_SECRET   the local JWT secret (`supabase status -o env`, JWT_SECRET)
//
// Every run empties the app's tables and deletes every Supabase Auth user, so both URLs must point
// to this computer.
import { randomBytes } from "node:crypto";

export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const SUPABASE_URL = process.env.SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const isLocal = (url) => { try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname); } catch { return false; } };
if (!DATABASE_URL || !SUPABASE_URL || !SECRET_KEY || !process.env.SUPABASE_JWT_SECRET) {
  throw new Error("Set TEST_DATABASE_URL, SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_JWT_SECRET for a local Supabase stack (supabase start).");
}
if (!isLocal(DATABASE_URL) || !isLocal(SUPABASE_URL)) {
  throw new Error("Tests empty the database and delete every sign-in: TEST_DATABASE_URL and SUPABASE_URL must be a local Supabase stack.");
}

/** Environment for the API server under test. */
export function serverEnv(port, extra = {}) {
  return {
    ...process.env,
    DATABASE_URL,
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
    SUPABASE_STORAGE_BUCKET: "medical-attachments-test",
    PORT: String(port),
    NODE_ENV: "test",
    TRUST_PROXY: "1",
    LOG_LEVEL: "warn",
    ...extra,
  };
}

async function admin(method, path, body) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Creates a confirmed Supabase Auth user and returns its id. Without a password it cannot sign in yet. */
export async function createAuthUser(email, password) {
  return (await admin("POST", "/auth/v1/admin/users", { email, ...(password ? { password } : {}), email_confirm: true })).id;
}

/** Empties the app's tables (the disease code catalogue stays) and deletes every Supabase Auth user. */
export async function resetDatabase(sql) {
  const { rows } = await sql.query("select tablename from pg_tables where schemaname = 'public' and tablename like 'medichain\\_%' and tablename <> 'medichain_disease_codes'");
  if (rows.length) await sql.query(`truncate ${rows.map((row) => `"${row.tablename}"`).join(", ")} restart identity cascade`);
  await sql.query("delete from auth.users");
}

/**
 * Inserts a doctor or administrator as an administrator would have approved them, with a
 * Supabase sign-in. Returns the account id.
 */
export async function insertStaff(sql, { email, password, role, name, terms, verified = true }) {
  const authUserId = await createAuthUser(email, password);
  const { rows } = await sql.query(
    `insert into medichain_users (email, auth_user_id, role, name, hospital_name, professional_medical_number, doctor_verified, contact_info, terms_version, terms_accepted_at)
     values ($1, $2, $3, $4, $5, $6, $7, '+237677000000', $8, now()) returning id`,
    [email, authUserId, role, name, role === "ADMIN" ? null : "Hôpital Laquintinie", role === "ADMIN" ? null : "ONMC-1234", verified, terms],
  );
  return rows[0].id;
}

/** Lets a test sign in again within the same 30 seconds, which a real code cannot do. */
export const allowCodeReuse = (sql, email) => sql.query("update medichain_users set mfa_last_code_hash = null where email = $1", [email]);

export const randomSecret = () => randomBytes(24).toString("hex");
