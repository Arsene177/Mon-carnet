// What the server does when it starts on a host without a Shell or scheduled jobs (Render's free
// plan): it creates the first administrator from INITIAL_ADMIN_* once, and makes a daily backup
// itself (BACKUP_SCHEDULE=daily). Runs against the local Supabase stack; needs pg_dump 17.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DATABASE_URL, SUPABASE_URL, resetDatabase, serverEnv } from "./supabase-test-env.mjs";

const PORT = 6800 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}/api`;
const BUCKET = `backups-startup-test`;
const ADMIN = { email: `first-admin-${Date.now()}@test.cm`, password: "First-admin-password-42" };
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const sql = new pg.Pool({ connectionString: DATABASE_URL });
let server;

async function storage(method, path, body) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1${path}`, {
    method, headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json().catch(() => null);
}
const backupsInBucket = async () => {
  const items = await storage("POST", `/object/list/${BUCKET}`, { prefix: "", limit: 1000 });
  return Array.isArray(items) ? items.filter((item) => /^mon-carnet-backup-.*\.mcbk$/.test(item.name)).length : 0;
};

async function startServer() {
  const child = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: serverEnv(PORT, {
      INITIAL_ADMIN_EMAIL: ADMIN.email, INITIAL_ADMIN_PASSWORD: ADMIN.password, INITIAL_ADMIN_NAME: "First Admin",
      BACKUP_SCHEDULE: "daily", BACKUP_FIRST_CHECK_SECONDS: "1", SUPABASE_BACKUP_BUCKET: BUCKET,
      BACKUP_ENCRYPTION_KEY: "startup-test-backup-key-0123456789-abcdef",
      // Left empty so the value kept in Supabase Vault applies.
      TRUST_PROXY: "",
    }),
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return child; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The API server did not start.");
}
const stop = (child) => new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
const waitFor = async (check, seconds) => {
  for (let i = 0; i < seconds * 2; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 500)); }
  return false;
};

const clearVault = () => sql.query("delete from vault.secrets where name like 'mon_carnet.%'");

before(async () => {
  await resetDatabase(sql);
  await clearVault();
  await sql.query("select vault.create_secret('3', 'mon_carnet.TRUST_PROXY')");
  await sql.query("select vault.create_secret('ignored', 'mon_carnet.SUPABASE_SECRET_KEY')");
  const items = await storage("POST", `/object/list/${BUCKET}`, { prefix: "", limit: 1000 });
  if (Array.isArray(items) && items.length) await storage("DELETE", `/object/${BUCKET}`, { prefixes: items.map((item) => item.name) });
  server = await startServer();
});

after(async () => {
  if (server) await stop(server);
  await clearVault();
  await resetDatabase(sql);
  await sql.end();
});

describe("starting on a host without a Shell or scheduled jobs", () => {
  test("the first administrator is created from INITIAL_ADMIN_* and can sign in", async () => {
    const { rows } = await sql.query("select name, role, auth_user_id is not null as linked from medichain_users where email = $1", [ADMIN.email]);
    assert.deepEqual(rows, [{ name: "First Admin", role: "ADMIN", linked: true }]);
    const response = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ADMIN) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.user.role, "ADMIN");
    // Two-step sign-in comes next, as for every administrator.
    assert.equal(body.user.mfaRequired, true);
  });

  test("settings kept in Supabase Vault apply, and only the allowed ones", async () => {
    const seen = await (await fetch(`${BASE}/client-address`, { headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1, 10.0.0.2" } })).json();
    assert.equal(seen.trustProxy, 3);
    assert.equal(seen.address, "198.51.100.9");
    // The server still works with its own secret key, not the one planted in Vault.
    assert.equal((await fetch(`${BASE}/readyz`)).status, 200);
  });

  test("a backup is made without anyone starting it", async () => {
    assert.ok(await waitFor(async () => (await backupsInBucket()) === 1, 60), "a backup appears in the bucket");
  });

  test("starting again creates no second administrator and no second backup the same day", async () => {
    await stop(server);
    server = await startServer();
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const { rows } = await sql.query("select count(*)::int as n from medichain_users where role = 'ADMIN'");
    assert.equal(rows[0].n, 1);
    assert.equal(await backupsInBucket(), 1);
  });
});
