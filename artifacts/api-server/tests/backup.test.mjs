// Backup and restore: encrypted backups of the database (the app's tables and the Supabase Auth
// sign-ins) and attached files, restored into an emptied Supabase database, as into a fresh project.
// Runs against the local Supabase stack (tests/supabase-test-env.mjs). Needs pg_dump and
// pg_restore of the database's major version (17) on the PATH.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DATABASE_URL, SUPABASE_URL, createAuthUser, resetDatabase, serverEnv } from "./supabase-test-env.mjs";

const KEY = "test-backup-key-0123456789-abcdefghijklmnop";
const FILE_BUCKET = "medical-attachments-test";
const BACKUP_BUCKET = "backups-test";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const serverDir = fileURLToPath(new URL("..", import.meta.url));

const sql = new pg.Pool({ connectionString: DATABASE_URL });
let workDir;
let authUserId;
const marker = `backup-marker-${Date.now()}@test.cm`;
const attachmentBytes = Buffer.from(`%PDF-1.4 scanned lab result ${Date.now()}`);
const objectPath = `/objects/uploads/${randomUUID()}`;
const objectName = objectPath.slice("/objects/".length);

async function storage(method, pathname, body, contentType = "application/json") {
  const response = await fetch(`${SUPABASE_URL}/storage/v1${pathname}`, {
    method,
    headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}`, "content-type": contentType, "x-upsert": "true" },
    body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : body,
  });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

function tool(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/backup.mjs", ...args], {
      cwd: serverDir,
      env: { ...serverEnv(0), BACKUP_ENCRYPTION_KEY: KEY, SUPABASE_BACKUP_BUCKET: BACKUP_BUCKET, ...env },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function newestBackup() {
  const files = (await readdir(workDir)).filter((file) => file.endsWith(".mcbk")).sort();
  return path.join(workDir, files.at(-1));
}

const count = async (table, where = "true", params = []) => (await sql.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0].n;

/** Leaves the database like a new Supabase project: no app rows, no sign-ins, no stored files. */
async function emptyProject() {
  await resetDatabase(sql);
  await storage("DELETE", `/object/${FILE_BUCKET}`, { prefixes: [objectName] });
}

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "mon-carnet-backup-test-"));
  await resetDatabase(sql);
  // A patient with a sign-in and one attached file, so the backup has something recognisable in it.
  authUserId = await createAuthUser(marker, "Correct-horse-9");
  const { rows: [patient] } = await sql.query(
    "insert into medichain_users (email, auth_user_id, role, name) values ($1, $2, 'PATIENT', 'Backup Marker') returning id",
    [marker, authUserId],
  );
  await sql.query(
    "insert into medichain_medical_attachments (patient_id, doctor_id, object_path, file_name, content_type, size, status) values ($1, $1, $2, 'lab.pdf', 'application/pdf', $3, 'READY')",
    [patient.id, objectPath, attachmentBytes.length],
  );
  await storage("POST", "/bucket", { id: FILE_BUCKET, name: FILE_BUCKET, public: false });
  const uploaded = await storage("POST", `/object/${FILE_BUCKET}/${objectName}`, attachmentBytes, "application/pdf");
  assert.equal(uploaded.status, 200, uploaded.body.toString());
});

after(async () => {
  await resetDatabase(sql);
  await sql.end();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("backups", () => {
  test("a backup is encrypted: no personal data can be read from the file", async () => {
    const result = await tool(["backup", "--out", workDir, "--upload"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /1 sign-ins, 1 attached files/);
    const bytes = await readFile(await newestBackup());
    assert.equal(bytes.subarray(0, 5).toString(), "MCBK1");
    assert.equal(bytes.includes(Buffer.from(marker)), false);
    assert.equal(bytes.includes(attachmentBytes), false);
    const uploadedName = result.output.match(/Uploaded to Supabase Storage: [^/]+\/(\S+\.mcbk)/)?.[1];
    assert.ok(uploadedName, result.output);
    const listed = JSON.parse((await storage("POST", `/object/list/${BACKUP_BUCKET}`, { prefix: "", limit: 1000 })).body.toString());
    assert.ok(listed.some((item) => item.name === uploadedName), "uploaded to the backup bucket");
    const bucket = JSON.parse((await storage("GET", `/bucket/${BACKUP_BUCKET}`)).body.toString());
    assert.equal(bucket.public, false);
  });

  test("verify reads it with the right key and refuses a wrong key or a damaged file", async () => {
    const file = await newestBackup();
    const ok = await tool(["verify", "--file", file]);
    assert.equal(ok.code, 0, ok.output);
    assert.match(ok.output, /1 attached files/);
    const wrongKey = await tool(["verify", "--file", file], { BACKUP_ENCRYPTION_KEY: "another-key-that-is-long-enough-0123456789" });
    assert.notEqual(wrongKey.code, 0);
    assert.match(wrongKey.output, /could not be decrypted/);
    const damaged = path.join(workDir, "damaged.bin");
    const bytes = await readFile(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await writeFile(damaged, bytes);
    assert.notEqual((await tool(["verify", "--file", damaged])).code, 0);
  });

  test("a backup cannot be made without an encryption key", async () => {
    const result = await tool(["backup", "--out", workDir], { BACKUP_ENCRYPTION_KEY: "" });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /BACKUP_ENCRYPTION_KEY/);
  });

  test("restoring into an empty Supabase project brings back the data, the sign-ins and the attached files", async () => {
    const file = await newestBackup();
    await emptyProject();
    assert.equal(await count("auth.users"), 0);
    const result = await tool(["restore", "--file", file, "--target-database-url", DATABASE_URL, "--restore-attachments"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /row counts match/);
    assert.equal(await count("medichain_users", "email = $1 and auth_user_id = $2", [marker, authUserId]), 1);
    assert.equal(await count("auth.users", "id = $1 and email = $2 and encrypted_password <> ''", [authUserId, marker]), 1);
    const restored = await storage("GET", `/object/${FILE_BUCKET}/${objectName}`);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body, attachmentBytes);
    // Still closed to Supabase's public API after the restore.
    assert.equal(await count("pg_tables", "schemaname = 'public' and tablename like 'medichain\\_%' and not rowsecurity"), 0);
  });

  test("a restore never overwrites existing data unless asked to", async () => {
    const refused = await tool(["restore", "--file", await newestBackup(), "--target-database-url", DATABASE_URL]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.output, /already holds/);
    const replaced = await tool(["restore", "--file", await newestBackup(), "--target-database-url", DATABASE_URL, "--replace-existing-data"]);
    assert.equal(replaced.code, 0, replaced.output);
    assert.equal(await count("medichain_users", "email = $1", [marker]), 1);
    assert.equal(await count("auth.users"), 1);
  });
});
