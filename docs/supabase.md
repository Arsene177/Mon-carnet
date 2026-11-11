# Supabase

Mon carnet keeps its data in a Supabase project: the database (Postgres), the sign-ins (Supabase Auth) and the lab files (Supabase Storage). The app runs on Render (`render.yaml`, `Dockerfile`): one web service that serves the website and the API, and a daily backup job. **Step-by-step setup, with where to click: `docs/render.md`.** This page is the reference.

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

Environment variables (on Render: each service > **Environment**; the scripts read the same names):

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | Supabase **Connect** > **Session pooler** connection string, with the database password filled in. (The direct connection needs IPv6, which Render does not offer.) |
| `SUPABASE_URL` | Project Settings > Data API > Project URL, e.g. `https://abcd.supabase.co` |
| `SUPABASE_SECRET_KEY` | Project Settings > API Keys > a **secret** key (`sb_secret_...`). The legacy `service_role` key also works. Never put it anywhere else: it bypasses every protection. |
| `SUPABASE_JWT_SECRET` | Only if the project still signs tokens with the legacy JWT secret (Project Settings > JWT Keys says "Legacy JWT secret" is in use). Projects using JWT signing keys need nothing here. The server logs an error at start-up if it cannot verify tokens. |
| `SUPABASE_STORAGE_BUCKET`, `SUPABASE_BACKUP_BUCKET` | Optional; defaults `medical-attachments` and `backups`. |

Set by `render.yaml` or the `Dockerfile`: `TRUST_PROXY` (proxies in front of the app; check `GET /api/client-address` after deploying), `WEB_DIST_DIR` (the built web app the server serves), `PORT`, `NODE_ENV`. The backup job also needs `BACKUP_ENCRYPTION_KEY`. No longer used: `JWT_SECRET`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`; `PRIVATE_OBJECT_DIR` only for the one-time copy below.

Supabase dashboard:

1. **Authentication > Sign In / Providers**: turn **off** "Allow new users to sign up" (the app creates accounts through the API; with sign-ups on, anyone with the project's public key could create Supabase users, which the app would refuse but which clutter the user list). Keep the **Email** provider on.
2. **Authentication > Rate Limits**: raise **Sign-ups and sign-ins** and **Token refreshes**. Supabase counts them per IP address, and every request comes from the app's server, so the defaults (30 sign-ins and 150 refreshes per 5 minutes) apply to all users together. 1,000 and 2,000 per 5 minutes are reasonable; the app keeps its own per-account and per-address limits.
3. **Authentication > Multi-Factor**: authenticator app (TOTP) **enabled** (the default).
4. **Authentication > Providers > Email**: "Secure password change" **off**. The app asks for the current password itself.
5. **Project Settings > API Keys**: the app does not need the publishable (or `anon`) key. Do not put it in the web app or anywhere public.
6. **Plan**: a Free project is paused after a week without activity and has no daily backups. For real patients, use a paid plan, and keep the app's own encrypted backups (`docs/backup-and-restore.md`).
7. **Region**: health data is stored in the project's region. The privacy policy (`artifacts/medichain/src/pages/legal.tsx`) must name the host (Supabase) and the region; this belongs to the legal review.

## Moving from Replit to Supabase (once)

Follow `docs/render.md`, Part 4. In short: the copy runs one last time inside Replit (only Replit can read its file storage), with `SOURCE_DATABASE_URL` set to the old Replit database and `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` set to Supabase: a `--dry-run` first, then the copy, then the copy again to confirm the counts match.

- It copies every table keeping every id, in one transaction, and checks the row counts.
- It creates a Supabase Auth sign-in for every account that is not closed. **Passwords do not change**: each account keeps its old password hash, and its first successful sign-in moves the password to Supabase Auth.
- **Two-step sign-in has to be set up again** (Supabase cannot take the old authenticator secrets), so it is turned off and old recovery codes are not copied. Doctors and administrators are asked to set it up at their first sign-in.
- It copies the lab files to the private bucket and checks their sizes, then closes the tables to the public API.
- If it stops, run it again: it continues where it stopped. Nothing is deleted from Replit.

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
