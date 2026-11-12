// Closes the app's tables to Supabase's public APIs (PostgREST, GraphQL, Realtime). Runs after every
// schema push. Only the API server, which connects with the database password, may read or change data.
//
// - Removes every row-level security policy on the medichain_* tables. Policies would let the public
//   "anon" or "authenticated" roles in; the app needs none. (An early migration created policies that
//   let anyone with the public key read and change everything.)
// - Turns on row-level security on every medichain_* table, so a forgotten grant still returns no rows.
// - Takes every privilege on the public schema away from anon and authenticated, now and for tables
//   created later.
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query(`
    do $$
    declare item record;
    begin
      for item in select tablename, policyname from pg_policies where schemaname = 'public' and tablename like 'medichain\\_%' loop
        execute format('drop policy %I on public.%I', item.policyname, item.tablename);
      end loop;
      for item in select tablename from pg_tables where schemaname = 'public' and tablename like 'medichain\\_%' loop
        execute format('alter table public.%I enable row level security', item.tablename);
      end loop;
      if exists (select from pg_roles where rolname = 'anon') and exists (select from pg_roles where rolname = 'authenticated') then
        revoke all on all tables in schema public from anon, authenticated;
        revoke all on all sequences in schema public from anon, authenticated;
        revoke all on all functions in schema public from anon, authenticated;
        alter default privileges in schema public revoke all on tables from anon, authenticated;
        alter default privileges in schema public revoke all on sequences from anon, authenticated;
        alter default privileges in schema public revoke all on functions from anon, authenticated;
      end if;
    end $$;
    select count(*)::int as tables,
           count(*) filter (where c.relrowsecurity)::int as protected
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'medichain\\_%';
  `).then((results) => results.at(-1));
  const [{ tables, protected: secured }] = rows;
  if (tables !== secured) throw new Error(`Row-level security is off on ${tables - secured} of ${tables} tables.`);
  console.log(`Locked down ${tables} tables: row-level security on, no public access.`);
} finally {
  await client.end();
}
