// Backup and restore: encrypted backups of the database and attached files, restored into a
// separate empty database. Uses TEST_DATABASE_URL as the source and creates a second database
// next to it (its name with "_restore") as the restore target. Needs pg_dump and pg_restore.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const SOURCE_URL = process.env.TEST_DATABASE_URL;
if (!SOURCE_URL || !/test/i.test(new URL(SOURCE_URL).pathname)) {
  throw new Error("Set TEST_DATABASE_URL to a disposable database whose name contains \"test\".");
}
const targetUrl = new URL(SOURCE_URL);
const TARGET_DB = `${targetUrl.pathname.slice(1)}_restore`;
targetUrl.pathname = `/${TARGET_DB}`;
const TARGET_URL = targetUrl.toString();
const KEY = "test-backup-key-0123456789-abcdefghijklmnop";
const serverDir = fileURLToPath(new URL("..", import.meta.url));

const source = new pg.Pool({ connectionString: SOURCE_URL });
let storage;
let storagePort;
const objects = new Map();
let workDir;
const marker = `backup-marker-${Date.now()}@test.cm`;
const attachmentBytes = Buffer.from(`%PDF-1.4 scanned lab result ${Date.now()}`);

/** Stand-in for the Replit storage sidecar and the bucket behind it. */
function startFakeStorage() {
  return new Promise((resolve) => {
    storage = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (req.url === "/object-storage/signed-object-url") {
        const { bucket_name, object_name } = JSON.parse(body.toString());
        res.end(JSON.stringify({ signed_url: `http://127.0.0.1:${storagePort}/o/${bucket_name}/${object_name}` }));
        return;
      }
      const key = decodeURIComponent(req.url.slice(3));
      if (req.method === "PUT") { objects.set(key, body); res.end(); return; }
      if (req.method === "GET" && objects.has(key)) { res.end(objects.get(key)); return; }
      res.statusCode = 404;
      res.end();
    }).listen(0, "127.0.0.1", () => { storagePort = storage.address().port; resolve(); });
  });
}

function tool(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/backup.mjs", ...args], {
      cwd: serverDir,
      env: {
        ...process.env,
        DATABASE_URL: SOURCE_URL,
        BACKUP_ENCRYPTION_KEY: KEY,
        PRIVATE_OBJECT_DIR: "/test-bucket/private",
        OBJECT_STORAGE_SIDECAR_URL: `http://127.0.0.1:${storagePort}`,
        ...env,
      },
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

async function targetCount(table, where = "true", params = []) {
  const client = new pg.Client({ connectionString: TARGET_URL });
  await client.connect();
  try {
    return (await client.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0].n;
  } finally {
    await client.end();
  }
}

before(async () => {
  await startFakeStorage();
  workDir = await mkdtemp(path.join(tmpdir(), "mon-carnet-backup-test-"));
  // Attachments left by other test files point at storage this test cannot reach.
  await source.query("delete from medichain_medical_attachments");
  await source.query(`drop database if exists "${TARGET_DB}"`);
  await source.query(`create database "${TARGET_DB}"`);
  // A patient with one attached file, so the backup has something recognisable in it.
  const { rows: [patient] } = await source.query(
    "insert into medichain_users (email, password_hash, role, name) values ($1, 'x', 'PATIENT', 'Backup Marker') returning id",
    [marker],
  );
  const objectPath = `/objects/uploads/backup-test-${Date.now()}`;
  await source.query(
    "insert into medichain_medical_attachments (patient_id, doctor_id, object_path, file_name, content_type, size, status) values ($1, $1, $2, 'lab.pdf', 'application/pdf', $3, 'READY')",
    [patient.id, objectPath, attachmentBytes.length],
  );
  objects.set(`test-bucket/private/${objectPath.slice("/objects/".length)}`, attachmentBytes);
});

after(async () => {
  storage?.close();
  await source.query("delete from medichain_users where email = $1", [marker]);
  await source.query(`drop database if exists "${TARGET_DB}"`);
  await source.end();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("backups", () => {
  test("a backup is encrypted: no personal data can be read from the file", async () => {
    const result = await tool(["backup", "--out", workDir, "--upload"]);
    assert.equal(result.code, 0, result.output);
    const bytes = await readFile(await newestBackup());
    assert.equal(bytes.subarray(0, 5).toString(), "MCBK1");
    assert.equal(bytes.includes(Buffer.from(marker)), false);
    assert.equal(bytes.includes(attachmentBytes), false);
    assert.ok([...objects.keys()].some((key) => key.startsWith("test-bucket/private/backups/mon-carnet-backup-")), "uploaded to storage");
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

  test("restoring into an empty database brings back the data and the attached files", async () => {
    objects.clear();
    const result = await tool(["restore", "--file", await newestBackup(), "--target-database-url", TARGET_URL, "--restore-attachments"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /row counts match/);
    assert.equal(await targetCount("medichain_users", "email = $1", [marker]), 1);
    const restored = [...objects.entries()].find(([key]) => key.includes("uploads/backup-test-"));
    assert.ok(restored, "attachment uploaded back");
    assert.deepEqual(restored[1], attachmentBytes);
  });

  test("a restore never overwrites existing data unless asked to", async () => {
    const refused = await tool(["restore", "--file", await newestBackup(), "--target-database-url", TARGET_URL]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.output, /already holds/);
    const replaced = await tool(["restore", "--file", await newestBackup(), "--target-database-url", TARGET_URL, "--replace-existing-data"]);
    assert.equal(replaced.code, 0, replaced.output);
    assert.equal(await targetCount("medichain_users", "email = $1", [marker]), 1);
  });
});
