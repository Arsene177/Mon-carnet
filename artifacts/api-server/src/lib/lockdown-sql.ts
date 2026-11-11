// The same statements as lib/db/scripts/lockdown.mjs (which runs after every schema push): close the
// app's tables to Supabase's public API. Used after a restore and after the copy from Replit.
export const LOCKDOWN_SQL = `
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
  end $$;`;
