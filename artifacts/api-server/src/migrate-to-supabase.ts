// One-time copy of Mon carnet from Replit (database and Object Storage) to Supabase.
//
//   pnpm --filter @workspace/api-server run migrate-to-supabase -- --dry-run
//   pnpm --filter @workspace/api-server run migrate-to-supabase
//
// Run it on Replit, where the old database and the old file storage are reachable, after the schema
// has been pushed to Supabase (pnpm --filter @workspace/db run push with DATABASE_URL = Supabase).
//
//   SOURCE_DATABASE_URL   the old (Replit) database: read only, never changed
//   DATABASE_URL          the Supabase database
//   SUPABASE_URL, SUPABASE_SECRET_KEY
//   PRIVATE_OBJECT_DIR    the old Replit Object Storage folder with the lab files (skip with --skip-files)
//
// What it does, in order (each step can be run again: it continues where it stopped):
//   1. Copies every app table, keeping every id, in one transaction, and checks the row counts.
//   2. Creates a Supabase Auth sign-in for every account that is not closed. Passwords are not
//      copied: each account keeps its old password hash, and its first successful sign-in moves the
//      password to Supabase Auth. Two-step sign-in has to be set up again (Supabase cannot take the
//      old authenticator secrets), so it is turned off and old recovery codes are removed.
//   3. Copies the lab files to the private Supabase Storage bucket and checks their sizes.
//   4. Closes the tables to Supabase's public API.
// Nothing is deleted from Replit.
import pg from "pg";
import { LOCKDOWN_SQL } from "./lib/lockdown-sql";
import { attachmentObjectName as replitObject, signedStorageUrl } from "./lib/replit-storage";
import { SupabaseError, createAuthUserWithoutPassword, ensureStorageBucket } from "./lib/supabase";
import { storedFileExists, writeStoredFile } from "./lib/object-storage";

class UsageError extends Error {}

const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
const dryRun = args.has("--dry-run");
const skipFiles = args.has("--skip-files");

const log = (message: string) => console.log(message);

async function appTables(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename like 'medichain\\_%' order by tablename");
  return rows.map((row) => row.tablename);
}

/** Tables ordered so every table comes after the tables its foreign keys point to. */
async function dependencyOrder(client: pg.ClientBase, tables: string[]): Promise<string[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
    from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace`);
  const parents = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const { child, parent } of rows) if (child !== parent && parents.has(child) && parents.has(parent)) parents.get(child)!.add(parent);
  const ordered: string[] = [];
  const visit = (table: string, path: Set<string>) => {
    if (ordered.includes(table)) return;
    if (path.has(table)) throw new Error(`Circular foreign keys around ${table}.`);
    path.add(table);
    for (const parent of parents.get(table) ?? []) visit(parent, path);
    path.delete(table);
    ordered.push(table);
  };
  for (const table of tables) visit(table, new Set());
  return ordered;
}

async function columns(client: pg.ClientBase, table: string): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [table]);
  return rows.map((row) => row.column_name);
}

const count = async (client: pg.ClientBase, table: string) => (await client.query<{ n: number }>(`select count(*)::int as n from "${table}"`)).rows[0]!.n;

// ---- 1. Tables -------------------------------------------------------------------------------

async function copyTables(source: pg.Client, target: pg.Client): Promise<void> {
  const sourceTables = await appTables(source);
  const targetTables = new Set(await appTables(target));
  if (!targetTables.has("medichain_users") || !(await columns(target, "medichain_users")).includes("auth_user_id")) {
    throw new UsageError("The Supabase database has no Mon carnet schema yet. Run: DATABASE_URL=<Supabase> pnpm --filter @workspace/db run push");
  }
  const missing = sourceTables.filter((table) => !targetTables.has(table));
  if (missing.length) throw new UsageError(`These tables are missing in Supabase: ${missing.join(", ")}. Push the schema first.`);

  const sourceUsers = await count(source, "medichain_users");
  const targetUsers = await count(target, "medichain_users");
  if (targetUsers > 0) {
    if (targetUsers !== sourceUsers) {
      throw new UsageError(`Supabase already holds ${targetUsers} accounts (Replit has ${sourceUsers}). Copy into an empty Supabase project.`);
    }
    log(`1. Tables: already copied (${targetUsers} accounts in Supabase); checking counts.`);
  } else {
    const order = await dependencyOrder(source, sourceTables);
    log(`1. Copying ${order.length} tables${dryRun ? " (dry run: counting only)" : ""}...`);
    if (dryRun) {
      for (const table of order) log(`   ${table}: ${await count(source, table)} rows`);
      return;
    }
    await target.query("begin");
    try {
      // Clears what the API server may already have filled in (the disease code catalogue).
      await target.query(`truncate ${order.map((table) => `"${table}"`).join(", ")} restart identity cascade`);
      for (const table of order) {
        if (table === "medichain_mfa_recovery_codes") {
          log(`   ${table}: not copied (two-step sign-in is set up again, with new recovery codes)`);
          continue;
        }
        // Columns the old schema had and the new one dropped (old session and authenticator fields) are left behind.
        const targetColumns = new Set(await columns(target, table));
        const shared = (await columns(source, table)).filter((column) => targetColumns.has(column));
        const list = shared.map((column) => `"${column}"`).join(", ");
        let copied = 0;
        let lastId = -1;
        for (;;) {
          // Postgres turns the rows into JSON and back, so dates, arrays and JSON values keep their exact form.
          const { rows: [page] } = await source.query<{ rows: string | null; last: number | null; n: number }>(
            `select json_agg(row_to_json(t))::text as rows, max(t.id) as last, count(*)::int as n
             from (select ${list} from "${table}" where id > $1 order by id limit 1000) t`, [lastId]);
          if (!page || page.n === 0) break;
          await target.query(`insert into "${table}" (${list}) select ${list} from json_populate_recordset(null::"${table}", $1::json)`, [page.rows]);
          copied += page.n;
          lastId = page.last!;
        }
        if ((await columns(target, table)).includes("id")) {
          await target.query(`select setval(pg_get_serial_sequence('"${table}"', 'id'), coalesce((select max(id) from "${table}"), 1), (select max(id) from "${table}") is not null)`);
        }
        log(`   ${table}: ${copied} rows`);
      }
      // Authenticators cannot be moved: everyone sets up two-step sign-in again. Old non-password
      // markers of closed accounts are dropped.
      await target.query("update medichain_users set mfa_enabled_at = null, mfa_last_code_hash = null, mfa_last_code_at = null, auth_user_id = null");
      await target.query("update medichain_users set password_hash = null where password_hash not like 'scrypt$%' or closed_at is not null");
      await target.query("commit");
    } catch (error) {
      await target.query("rollback");
      throw error;
    }
  }
  const differences: string[] = [];
  for (const table of sourceTables) {
    const [from, to] = [await count(source, table), await count(target, table)];
    if (from !== to && table !== "medichain_mfa_recovery_codes") differences.push(`${table}: Replit ${from}, Supabase ${to}`);
  }
  if (differences.length) throw new Error(`Row counts differ: ${differences.join("; ")}`);
  log("   Row counts match for every table.");
}

// ---- 2. Sign-ins -----------------------------------------------------------------------------

async function createSignIns(target: pg.Client): Promise<void> {
  const { rows } = await target.query<{ id: number; email: string }>(
    "select id, email from medichain_users where auth_user_id is null and closed_at is null order by id");
  log(`2. Creating Supabase sign-ins for ${rows.length} accounts${dryRun ? " (dry run: none created)" : ""}...`);
  if (dryRun) return;
  let created = 0;
  for (const user of rows) {
    let authUserId: string;
    try {
      authUserId = await createAuthUserWithoutPassword(user.email);
    } catch (error) {
      if (!(error instanceof SupabaseError && error.code === "email_exists")) throw error;
      // Created by an earlier run that stopped before saving the link.
      const { rows: [existing] } = await target.query<{ id: string }>("select id from auth.users where lower(email) = lower($1)", [user.email]);
      if (!existing) throw error;
      authUserId = existing.id;
    }
    await target.query("update medichain_users set auth_user_id = $1 where id = $2", [authUserId, user.id]);
    created++;
    if (created % 50 === 0) log(`   ${created} of ${rows.length}`);
  }
  const { rows: [left] } = await target.query<{ n: number }>("select count(*)::int as n from medichain_users where auth_user_id is null and closed_at is null");
  if (left!.n > 0) throw new Error(`${left!.n} accounts still have no sign-in.`);
  log(`   Done: every open account has a sign-in. Passwords move over at each person's first sign-in.`);
}

// ---- 3. Files --------------------------------------------------------------------------------

async function copyFiles(target: pg.Client): Promise<void> {
  const { rows } = await target.query<{ object_path: string; content_type: string; size: number }>(
    "select object_path, content_type, size from medichain_medical_attachments where status in ('READY', 'ATTACHED') order by id");
  if (skipFiles) {
    log(`3. Skipping ${rows.length} lab files (--skip-files). Run again without it to copy them.`);
    return;
  }
  log(`3. Copying ${rows.length} lab files to Supabase Storage${dryRun ? " (dry run: none copied)" : ""}...`);
  if (dryRun || rows.length === 0) return;
  await ensureStorageBucket();
  let copied = 0;
  let skipped = 0;
  for (const file of rows) {
    if (await storedFileExists(file.object_path)) { skipped++; continue; }
    const { bucketName, objectName } = replitObject(file.object_path);
    const response = await fetch(await signedStorageUrl(bucketName, objectName, "GET", 15 * 60), { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok) throw new Error(`Reading ${file.object_path} from Replit storage failed with HTTP ${response.status}.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length !== file.size) throw new Error(`${file.object_path} is ${data.length} bytes in Replit storage, ${file.size} in the database.`);
    await writeStoredFile(file.object_path, data, file.content_type);
    copied++;
    if (copied % 20 === 0) log(`   ${copied + skipped} of ${rows.length}`);
  }
  log(`   Done: ${copied} copied, ${skipped} already there.`);
}

async function main(): Promise<void> {
  for (const arg of args) if (!["--dry-run", "--skip-files"].includes(arg)) throw new UsageError(`Unknown option ${arg}. Use --dry-run or --skip-files.`);
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.DATABASE_URL;
  if (!sourceUrl || !targetUrl) throw new UsageError("Set SOURCE_DATABASE_URL (the old Replit database) and DATABASE_URL (Supabase).");
  if (sourceUrl === targetUrl) throw new UsageError("SOURCE_DATABASE_URL and DATABASE_URL are the same database.");
  if (!skipFiles && !process.env.PRIVATE_OBJECT_DIR) throw new UsageError("Set PRIVATE_OBJECT_DIR to the old Replit storage folder, or pass --skip-files.");
  const source = new pg.Client({ connectionString: sourceUrl });
  const target = new pg.Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  try {
    if (!(await target.query("select to_regclass('auth.users') as t")).rows[0]?.t) {
      throw new UsageError("DATABASE_URL is not a Supabase database (it has no auth schema).");
    }
    // The old database is only read.
    await source.query("set session characteristics as transaction read only");
    await copyTables(source, target);
    if (dryRun && (await count(target, "medichain_users")) === 0) {
      log("2. Sign-ins and 3. files: counted after the tables are copied.");
      log("Dry run finished: nothing was changed.");
      return;
    }
    await createSignIns(target);
    await copyFiles(target);
    if (!dryRun) {
      await target.query(LOCKDOWN_SQL);
      log("4. Tables closed to Supabase's public API.");
      log("Copy finished. Nothing was deleted from Replit. Next steps: docs/supabase.md, \"Switch the app over\".");
    } else {
      log("Dry run finished: nothing was changed.");
    }
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof UsageError ? error.message : `The copy stopped: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix the problem and run the same command again: it continues where it stopped.");
  process.exit(1);
});
