# Supabase

Mon carnet keeps its data in a Supabase project: the database (Postgres), the sign-ins (Supabase Auth) and the lab files (Supabase Storage). The app itself still runs on Replit.

## What is where

| What | Where | Notes |
| --- | --- | --- |
| Accounts, records, audit log, everything else | Supabase database, `public` schema, tables `medichain_*` | Created by `pnpm --filter @workspace/db run push`. Every push also closes the tables to Supabase's public API (row-level security on, no rights for the `anon` and `authenticated` roles, no policies). |
| Passwords, sessions, authenticator apps | Supabase Auth (`auth` schema) | Each account row has `auth_user_id`. The app reads `auth.sessions` to refuse a signed-out session at once. |
| Lab files | Supabase Storage, private bucket `medical-attachments` | Created by the API server when it starts. Browsers upload and download through short-lived signed links. |
| Uploaded backups | Supabase Storage, private bucket `backups` | See `docs/backup-and-restore.md`. Keep a copy outside Supabase too. |

The web app never talks to Supabase. It signs in, renews its token and signs out through the app's own API (`/api/auth/*`), so the app's rate limits, account lock, audit log, two-step sign-in rules and security alerts apply to every sign-in. The web app contains no Supabase key.

Access tokens last about an hour; the web app renews them shortly before they expire. Signing out, changing the password, "sign out of all other devices", a temporary password, a suspension and closing an account delete sessions in Supabase Auth, which stops their tokens on the next request.

## Settings

Replit Secrets (the API server, the scripts and the published app):

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | Supabase **Connect** > **Session pooler** connection string, with the database password filled in. (Replit has no IPv6, which the direct connection needs.) |
| `SUPABASE_URL` | Project Settings > Data API > Project URL, e.g. `https://abcd.supabase.co` |
| `SUPABASE_SECRET_KEY` | Project Settings > API Keys > a **secret** key (`sb_secret_...`). The legacy `service_role` key also works. Never put it anywhere else: it bypasses every protection. |
| `SUPABASE_JWT_SECRET` | Only if the project still signs tokens with the legacy JWT secret (Project Settings > JWT Keys says "Legacy JWT secret" is in use). Projects using JWT signing keys need nothing here. The server logs an error at start-up if it cannot verify tokens. |
| `SUPABASE_STORAGE_BUCKET`, `SUPABASE_BACKUP_BUCKET` | Optional; defaults `medical-attachments` and `backups`. |

No longer used once the app runs on Supabase: `JWT_SECRET`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `PRIVATE_OBJECT_DIR` (still needed once, by the copy below).

Supabase dashboard:

1. **Authentication > Sign In / Providers**: turn **off** "Allow new users to sign up" (the app creates accounts through the API; with sign-ups on, anyone with the project's public key could create Supabase users, which the app would refuse but which clutter the user list). Keep the **Email** provider on.
2. **Authentication > Rate Limits**: raise **Sign-ups and sign-ins** and **Token refreshes**. Supabase counts them per IP address, and every request comes from the app's server, so the defaults (30 sign-ins and 150 refreshes per 5 minutes) apply to all users together. 1,000 and 2,000 per 5 minutes are reasonable; the app keeps its own per-account and per-address limits.
3. **Authentication > Multi-Factor**: authenticator app (TOTP) **enabled** (the default).
4. **Authentication > Providers > Email**: "Secure password change" **off**. The app asks for the current password itself.
5. **Project Settings > API Keys**: the app does not need the publishable (or `anon`) key. Do not put it in the web app or anywhere public.
6. **Plan**: a Free project is paused after a week without activity and has no daily backups. For real patients, use a paid plan, and keep the app's own encrypted backups (`docs/backup-and-restore.md`).
7. **Region**: health data is stored in the project's region. The privacy policy (`artifacts/medichain/src/pages/legal.tsx`) must name the host (Supabase) and the region; this belongs to the legal review.

## Moving from Replit to Supabase (once)

Do this at a quiet time. Tell doctors and administrators beforehand that they will have to set up their authenticator app again after the move (Supabase cannot take the old authenticator secrets); patients who used two-step sign-in can turn it on again in Profile. **Passwords do not change**: everyone signs in with their current password, which moves to Supabase Auth at that first sign-in.

1. **Check the Supabase project for old open tables.** An early migration (removed from this repository) let anyone with the public key read and change every row. In Table Editor, look for `medichain_*` tables. If there are any, step 3 locks them down; the copy (step 5) refuses a project that already holds accounts, so delete those old tables first if they contain test data (SQL Editor: `drop table if exists ... cascade`).
2. **Secrets.** In Replit Secrets, add `SOURCE_DATABASE_URL` with the **current** value of `DATABASE_URL` (the Replit database). Then set `DATABASE_URL` to the Supabase session pooler string, and add `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (and `SUPABASE_JWT_SECRET` if needed). Keep `PRIVATE_OBJECT_DIR`.
3. **Create the schema in Supabase**: `pnpm --filter @workspace/db run push`. It ends with "Locked down N tables".
4. **Dry run**: `pnpm --filter @workspace/api-server run migrate-to-supabase -- --dry-run`. It lists what would be copied and changes nothing.
5. **Copy**: `pnpm --filter @workspace/api-server run migrate-to-supabase`. It copies every table keeping every id, creates a sign-in per open account, copies the lab files and checks counts and sizes. If it stops (network, timeout), run it again: it continues where it stopped. Nothing is deleted from Replit.
6. **Publish** the app again straight away, so the published app uses the new secrets. Until then it still writes to the Replit database.
7. **Check nothing was written to Replit in between**: run step 5 again. It must say "Row counts match for every table". If it lists differences, something was saved in the old database after the copy; contact support before going further.
8. **Try it**: sign in as an administrator with your usual password, set up the authenticator app, open a patient's record and a lab file, look at System overview > Security events.
9. Remove `SOURCE_DATABASE_URL`, `PRIVATE_OBJECT_DIR`, `JWT_SECRET`, `SESSION_SECRET` and `MFA_ENCRYPTION_KEY` from Replit Secrets. Keep the Replit database and files untouched for 30 days, then delete them.

## Local development and tests

The tests run against a local Supabase stack configured by `supabase/config.toml` (sign-ups off, authenticator app on, high local rate limits). It needs Docker and the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase start -x studio,realtime,edge-runtime,logflare,vector,imgproxy,supavisor,postgres-meta,mailpit
```

```bash
eval "$(scripts/supabase-test-env.sh)"
```

```bash
DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @workspace/db run push
```

```bash
pnpm --filter @workspace/api-server run test
```

The tests empty the local database and delete every local sign-in, and refuse to run against anything that is not on this computer. The backup tests need `pg_dump` and `pg_restore` 17. GitHub Actions does the same on every push (`.github/workflows/checks.yml`).
