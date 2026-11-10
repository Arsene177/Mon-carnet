// Encrypted backups of the Mon carnet database and attached files, and restoring them.
//
//   pnpm --filter @workspace/api-server run backup [--out DIR] [--keep N] [--upload] [--skip-attachments]
//   pnpm --filter @workspace/api-server run backup:verify --file FILE
//   pnpm --filter @workspace/api-server run backup:restore --file FILE --target-database-url URL [--replace-existing-data] [--restore-attachments]
//   pnpm --filter @workspace/api-server run backup:download --name NAME [--out DIR]
//
// Needs BACKUP_ENCRYPTION_KEY (at least 32 characters) for every command, DATABASE_URL for
// `backup`, and pg_dump / pg_restore (PostgreSQL 16 client tools) on the PATH. Attached files
// are read and written through private object storage (PRIVATE_OBJECT_DIR). See
// docs/backup-and-restore.md for the schedule and the restore procedure.
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { attachmentObjectName, privateStorageRoot, signedStorageUrl } from "./lib/object-storage";

const MAGIC = Buffer.from("MCBK1");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const FORMAT_VERSION = 1;

type Manifest = {
  formatVersion: number;
  createdAt: string;
  pgDumpVersion: string;
  tableRowCounts: Record<string, number>;
  attachments: { objectPath: string; file: string; size: number; sha256: string }[];
  attachmentsSkipped: boolean;
};

class UsageError extends Error {}

// ---- Arguments and helpers -----------------------------------------------------------------

function parseArgs(argv: string[]): { command: string; options: Record<string, string | boolean> } {
  const [command = "", ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") continue; // separator some package managers pass through
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[key] = next;
      i++;
    } else {
      options[key] = true;
    }
  }
  return { command, options };
}

function stringOption(options: Record<string, string | boolean>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function encryptionKey(salt: Buffer): Buffer {
  const secret = process.env.BACKUP_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new UsageError("Set BACKUP_ENCRYPTION_KEY (at least 32 characters). Keep a copy outside Replit: without it no backup can be read.");
  }
  return Buffer.from(hkdfSync("sha256", secret, salt, "mon-carnet-backup-v1", 32));
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed (exit ${code}): ${stderr.trim().split("\n").slice(-5).join(" | ")}`));
    });
  });
}

/** pg tools take the connection from libpq variables so the password never appears in the process list. */
function libpqEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
  };
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function tableRowCounts(client: pg.ClientBase): Promise<Record<string, number>> {
  const { rows } = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename like 'medichain\\_%' order by tablename",
  );
  const counts: Record<string, number> = {};
  for (const { tablename } of rows) {
    const result = await client.query<{ n: number }>(`select count(*)::int as n from "${tablename}"`);
    counts[tablename] = result.rows[0]!.n;
  }
  return counts;
}

// ---- Encryption: MCBK1 | salt | iv | AES-256-GCM ciphertext | tag --------------------------

async function encryptFile(source: string, destination: string): Promise<void> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(salt), iv);
  const out = createWriteStream(destination, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(createReadStream(source), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), () => resolve()).on("error", reject));
}

async function decryptFile(source: string, destination: string): Promise<void> {
  const { size } = await stat(source);
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error("This file is too short to be a Mon carnet backup.");
  const handle = await open(source, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("This file is not a Mon carnet backup.");
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + SALT_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(source, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(destination, { mode: 0o600 }),
    );
  } catch {
    await unlink(destination).catch(() => undefined);
    throw new Error("The backup could not be decrypted: wrong BACKUP_ENCRYPTION_KEY, or the file is damaged.");
  }
}

/** Decrypts and unpacks a backup into a new temporary folder; returns the folder and manifest. */
async function unpack(file: string): Promise<{ dir: string; manifest: Manifest }> {
  const dir = await mkdtemp(path.join(tmpdir(), "mon-carnet-restore-"));
  const archive = path.join(dir, "backup.tar.gz");
  await decryptFile(file, archive);
  await run("tar", ["-xzf", archive, "-C", dir]);
  await unlink(archive);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`Unsupported backup format ${manifest.formatVersion}.`);
  for (const attachment of manifest.attachments) {
    const actual = await sha256File(path.join(dir, attachment.file));
    if (actual !== attachment.sha256) throw new Error(`Attached file ${attachment.objectPath} is damaged in this backup.`);
  }
  return { dir, manifest };
}

// ---- Storage -------------------------------------------------------------------------------

function backupObjectName(name: string): { bucketName: string; objectName: string } {
  const root = privateStorageRoot();
  if (!root) throw new UsageError("PRIVATE_OBJECT_DIR is not set, so backups cannot be stored in object storage.");
  if (!/^mon-carnet-backup-[0-9TZ-]+\.mcbk$/.test(name)) throw new UsageError("That is not a backup file name.");
  return { bucketName: root.bucketName, objectName: [root.directory, "backups", name].filter(Boolean).join("/") };
}

async function transfer(url: string, init: RequestInit & { duplex?: "half" }, what: string): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`${what} failed with HTTP ${response.status}.`);
  return response;
}

async function uploadFile(file: string, bucketName: string, objectName: string, contentType: string): Promise<void> {
  const url = await signedStorageUrl(bucketName, objectName, "PUT", 15 * 60);
  const { size } = await stat(file);
  await transfer(url, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(size) },
    body: Readable.toWeb(createReadStream(file)) as ReadableStream,
    duplex: "half",
  }, `Uploading ${objectName}`);
}

async function downloadFile(bucketName: string, objectName: string, destination: string): Promise<void> {
  const url = await signedStorageUrl(bucketName, objectName, "GET", 15 * 60);
  const response = await transfer(url, { method: "GET" }, `Downloading ${objectName}`);
  if (!response.body) throw new Error(`Downloading ${objectName} returned no data.`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(destination, { mode: 0o600 }));
}

// ---- Commands ------------------------------------------------------------------------------

async function backup(options: Record<string, string | boolean>): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new UsageError("Set DATABASE_URL to the database to back up.");
  encryptionKey(randomBytes(SALT_BYTES)); // fail before doing any work if the key is missing
  const outDir = path.resolve(stringOption(options, "out") ?? "backups");
  const keep = Number(stringOption(options, "keep") ?? 14);
  if (!Number.isInteger(keep) || keep < 1) throw new UsageError("--keep must be a whole number of at least 1.");
  const skipAttachments = options["skip-attachments"] === true;

  const work = await mkdtemp(path.join(tmpdir(), "mon-carnet-backup-"));
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // One snapshot for the counts, the attachment list and pg_dump, so they all describe the same moment.
    await client.query("begin isolation level repeatable read read only");
    const snapshot = (await client.query<{ id: string }>("select pg_export_snapshot() as id")).rows[0]!.id;
    const tableRowCounts_ = await tableRowCounts(client);
    const attachmentRows = (await client.query<{ object_path: string }>(
      "select object_path from medichain_medical_attachments where status = 'READY' order by id",
    )).rows;
    const pgDumpVersion = (await run("pg_dump", ["--version"])).trim();
    await run("pg_dump", [
      "--format=custom", "--no-owner", "--no-privileges", `--snapshot=${snapshot}`,
      `--file=${path.join(work, "database.dump")}`,
    ], libpqEnv(databaseUrl));
    await client.query("commit");

    const attachments: Manifest["attachments"] = [];
    if (attachmentRows.length > 0 && !skipAttachments) {
      if (!privateStorageRoot()) {
        throw new UsageError(`There are ${attachmentRows.length} attached files but PRIVATE_OBJECT_DIR is not set. Run where object storage is available, or pass --skip-attachments.`);
      }
      await mkdir(path.join(work, "attachments"));
      for (const [index, row] of attachmentRows.entries()) {
        const file = `attachments/${index}`;
        const { bucketName, objectName } = attachmentObjectName(row.object_path);
        await downloadFile(bucketName, objectName, path.join(work, file));
        const full = path.join(work, file);
        attachments.push({ objectPath: row.object_path, file, size: (await stat(full)).size, sha256: await sha256File(full) });
      }
    }

    const manifest: Manifest = {
      formatVersion: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      pgDumpVersion,
      tableRowCounts: tableRowCounts_,
      attachments,
      attachmentsSkipped: skipAttachments && attachmentRows.length > 0,
    };
    await writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest, null, 2));
    const archive = path.join(work, "backup.tar.gz");
    await run("tar", ["-czf", archive, "-C", work, "manifest.json", "database.dump", ...(attachments.length ? ["attachments"] : [])]);

    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const name = `mon-carnet-backup-${manifest.createdAt.replace(/[:.]/g, "-")}.mcbk`;
    const target = path.join(outDir, name);
    await encryptFile(archive, target);
    const size = (await stat(target)).size;
    console.log(`Backup written: ${target} (${(size / 1024 / 1024).toFixed(1)} MB, ${Object.values(tableRowCounts_).reduce((a, b) => a + b, 0)} rows, ${attachments.length} attached files)`);
    if (manifest.attachmentsSkipped) console.warn(`Warning: ${attachmentRows.length} attached files were NOT included (--skip-attachments).`);

    if (options.upload === true) {
      const { bucketName, objectName } = backupObjectName(name);
      await uploadFile(target, bucketName, objectName, "application/octet-stream");
      console.log(`Uploaded to object storage: ${objectName}`);
    }

    // Keep the newest `keep` backups in the output folder.
    const old = (await readdir(outDir)).filter((file) => /^mon-carnet-backup-.*\.mcbk$/.test(file)).sort().reverse().slice(keep);
    for (const file of old) await unlink(path.join(outDir, file));
    if (old.length) console.log(`Removed ${old.length} older local backup(s); keeping ${keep}.`);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
    await rm(work, { recursive: true, force: true });
  }
}

async function verify(options: Record<string, string | boolean>): Promise<void> {
  const file = stringOption(options, "file");
  if (!file) throw new UsageError("Pass --file with the backup to check.");
  const { dir, manifest } = await unpack(file);
  try {
    await run("pg_restore", ["--list", path.join(dir, "database.dump")]);
    const rows = Object.values(manifest.tableRowCounts).reduce((a, b) => a + b, 0);
    console.log(`Backup is readable and complete: made ${manifest.createdAt}, ${Object.keys(manifest.tableRowCounts).length} tables, ${rows} rows, ${manifest.attachments.length} attached files${manifest.attachmentsSkipped ? " (attached files were skipped when it was made)" : ""}.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function restore(options: Record<string, string | boolean>): Promise<void> {
  const file = stringOption(options, "file");
  const target = stringOption(options, "target-database-url");
  if (!file || !target) throw new UsageError("Pass --file and --target-database-url. The target is named explicitly so a restore never lands on the wrong database by accident.");

  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    const existing = await tableRowCounts(client);
    const rowsInTarget = Object.values(existing).reduce((a, b) => a + b, 0);
    if (rowsInTarget > 0 && options["replace-existing-data"] !== true) {
      throw new UsageError(`The target database already holds ${rowsInTarget} rows of Mon carnet data. Restore into an empty database, or pass --replace-existing-data to overwrite it.`);
    }
    const { dir, manifest } = await unpack(file);
    try {
      await run("pg_restore", [
        "--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error",
        `--dbname=${decodeURIComponent(new URL(target).pathname.slice(1))}`,
        path.join(dir, "database.dump"),
      ], libpqEnv(target));
      const restored = await tableRowCounts(client);
      const mismatches = Object.entries(manifest.tableRowCounts).filter(([table, n]) => restored[table] !== n);
      if (mismatches.length) {
        throw new Error(`Restored row counts differ from the backup: ${mismatches.map(([table, n]) => `${table} expected ${n}, got ${restored[table] ?? "missing"}`).join("; ")}`);
      }
      console.log(`Database restored from the backup made ${manifest.createdAt}: row counts match for all ${Object.keys(manifest.tableRowCounts).length} tables.`);

      if (manifest.attachments.length) {
        if (options["restore-attachments"] !== true) {
          console.log(`${manifest.attachments.length} attached files are in the backup but were not uploaded (pass --restore-attachments to put them back in object storage).`);
        } else {
          for (const attachment of manifest.attachments) {
            const { bucketName, objectName } = attachmentObjectName(attachment.objectPath);
            await uploadFile(path.join(dir, attachment.file), bucketName, objectName, "application/octet-stream");
          }
          console.log(`${manifest.attachments.length} attached files uploaded to object storage.`);
        }
      }
      if (manifest.attachmentsSkipped) console.warn("Warning: this backup was made with --skip-attachments, so attached files are missing.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await client.end();
  }
}

async function download(options: Record<string, string | boolean>): Promise<void> {
  const name = stringOption(options, "name");
  if (!name) throw new UsageError("Pass --name with the backup file name, e.g. mon-carnet-backup-2026-11-10T02-00-00-000Z.mcbk.");
  const outDir = path.resolve(stringOption(options, "out") ?? "backups");
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const { bucketName, objectName } = backupObjectName(name);
  await downloadFile(bucketName, objectName, path.join(outDir, name));
  console.log(`Downloaded ${path.join(outDir, name)}`);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  const commands: Record<string, (o: Record<string, string | boolean>) => Promise<void>> = { backup, verify, restore, download };
  const handler = commands[command];
  if (!handler) throw new UsageError("Usage: backup | verify --file F | restore --file F --target-database-url URL | download --name N");
  await handler(options);
}

main().catch((error: unknown) => {
  console.error(error instanceof UsageError ? error.message : `Backup tool failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
