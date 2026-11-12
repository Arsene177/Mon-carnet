# Backup and restore

Mon carnet holds medical records that cannot be recreated. This runbook says how backups are made, where they are kept, and how to bring the service back from one. It is written for whoever operates the production deployment.

## What a backup contains

One encrypted file (`mon-carnet-backup-<date>.mcbk`) with:

- the app's tables in the Supabase database (accounts, emergency information, medical records, coded diagnoses, access grants, audit log, notifications), taken from a single consistent snapshot by `pg_dump`;
- the sign-ins Supabase Auth keeps for those accounts (users with their password hashes, identities and authenticator factors), from the same snapshot. Sessions are not kept: after a restore everyone signs in again;
- every attached file (scans, lab results) in Supabase Storage that a record points to;
- a manifest with the row count of every table, the number of sign-ins and a SHA-256 checksum of every attached file, so a restore can prove it is complete.

The file is encrypted with AES-256-GCM using a key derived from `BACKUP_ENCRYPTION_KEY`. Without that key a backup cannot be read by anyone, including you. A damaged or altered file is detected and refused.

## Targets

| | Target | Why |
|---|---|---|
| Recovery point (data you can lose) | at most 24 hours | one backup per day |
| Recovery time (time to be back up) | under 4 hours | restore takes minutes; most time is deciding and checking |
| Copies | 3 copies, 2 kinds of storage, 1 away from Supabase | the "3-2-1" rule |
| Restore drill | every 3 months | a backup that was never restored is not known to work |

## One-time setup

1. **Create the encryption key.** On any computer run:

   ```bash
   openssl rand -base64 48
   ```

   Add the result as `BACKUP_ENCRYPTION_KEY` on the Render backup job (`mon-carnet-backup` > Environment; `docs/render.md`). Also store it in a password manager **and** on paper in a safe place. If this key is lost, every backup becomes unreadable. Never change it; if it must change (for example it leaked), keep the old key as well, because older backups still need it.

2. **The daily backup.** The Render cron job `mon-carnet-backup` (from `render.yaml`) runs every day at 01:00 UTC (02:00 in Douala):

   ```bash
   node --enable-source-maps artifacts/api-server/dist/backup.mjs backup --upload --out /tmp/backups
   ```

   It needs the same secrets as the app: `DATABASE_URL` (the Supabase database), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `BACKUP_ENCRYPTION_KEY`. `--upload` stores the file in the private Supabase Storage bucket `backups` (created on the first upload; `SUPABASE_BACKUP_BUCKET` changes the name). A file larger than the project's upload limit (Storage > Settings; 50 MB on the Free plan) is refused with a message: raise the limit, or keep that backup elsewhere. The command exits with an error if anything fails, so the run shows as failed in Render (`mon-carnet-backup` > Events; turn on Render's failure email in Account Settings > Notifications). Check the run history weekly. The first time, start it by hand with **Trigger Run** and check its log.

3. **Keep a copy away from Supabase (weekly).** The `backups` bucket is a second place, but it belongs to the same provider as the database. Once a week, download the newest backup to a computer and copy it to a second location that depends neither on Supabase nor on Render, for example an external drive kept off-site or another cloud storage account. The file is encrypted, so it is safe to store there. Download it in the Supabase dashboard (Storage > `backups`), or from a computer with this repository and the same environment variables:

   ```bash
   pnpm --filter @workspace/api-server run backup:download -- --name mon-carnet-backup-<date>.mcbk --out backups
   ```

   Keep daily backups for 30 days and one per month for as long as the medical-record retention period requires (still to be set by the legal review). Delete older files from the `backups` bucket by hand (Supabase dashboard > Storage); nothing deletes them automatically.

4. **Also use Supabase's own backups.** Paid Supabase plans keep daily database backups, and point-in-time recovery can be added. Keep them on. They are quicker for small mistakes but do not replace these backups: they do not cover Storage files, and they live with the same provider.

## Check that a backup is good

```bash
pnpm --filter @workspace/api-server run backup:verify -- --file backups/mon-carnet-backup-<date>.mcbk
```

This decrypts the file, checks every attached file against its checksum and checks that the database dump can be read. It changes nothing.

## Restore

Restoring replaces data, so go slowly and write down what you do.

1. **Decide what you are restoring and why.** Note the time of the incident and pick the newest backup made before it. Data entered after that backup will be lost; collect what you can (for example from doctors) to enter again.
2. **Stop writes.** Pause the production deployment, or put up a maintenance notice, so nobody adds data while you restore.
3. **Restore into a new, empty Supabase project first.** Create a new Supabase project (same region, same dashboard settings as in `docs/supabase.md`), then from a shell whose `SUPABASE_URL` and `SUPABASE_SECRET_KEY` point at the **new** project:

   ```bash
   pnpm --filter @workspace/api-server run backup:restore -- --file backups/mon-carnet-backup-<date>.mcbk --target-database-url "postgresql://…new project's session pooler…" --restore-attachments
   ```

   The target must be a Supabase database. The tool refuses one that already holds Mon carnet data or sign-ins unless you add `--replace-existing-data` (the disease code catalogue the API server fills in does not count), restores the tables and the sign-ins, closes the tables to the public API again, and checks every row count and the number of sign-ins against the backup. With `--restore-attachments` it uploads the files to the new project's private bucket.
4. **Check the restored data.** Point a test copy of the app at the new project and sign in with a test account (passwords are restored; sessions are not). Open one patient's records and a lab file.
5. **Switch production to it.** Either change the production `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (and `SUPABASE_JWT_SECRET` if used) to the restored project and publish again, or restore again into the production project with `--replace-existing-data`. A restore with `--replace-existing-data` replaces every sign-in of the target project.
6. **Files only.** If only attached files were lost, restore with `--restore-attachments` into a copy of the database, with `SUPABASE_URL` pointing at the production project: files are uploaded to the same paths, so records find them again.
7. **Resume service and record the incident** (see `docs/incident-response.md` when it exists): what happened, which backup was used, what data was lost, who was told.

## Restore drill (every 3 months)

1. Download the newest backup.
2. Run `backup:verify` on it.
3. Restore it into a new, empty Supabase project (step 3 above) and check the data (step 4).
4. Delete the test project.
5. Add a line below.

| Date | Backup used | Result | Time taken | Done by |
|---|---|---|---|---|
| | | | | |

## Requirements and limits

- The backup tool needs `pg_dump` and `pg_restore` of at least the database server's major version (new Supabase projects run PostgreSQL 17; Project Settings > Infrastructure shows it) and `tar`. The Render image (`Dockerfile`) installs the PostgreSQL 17 tools; on your own computer, install PostgreSQL 17 client tools.
- A backup holds the whole database in one file. That is fine for years at the current size; revisit if the file grows past a few gigabytes.
- Passwords are kept as the hashes Supabase Auth stores. Authenticator factors are restored with them; if a restored project cannot read them (Supabase encrypts factor secrets with a project key on some setups), reset two-step sign-in for the affected accounts from User search.
- The automated tests (`pnpm --filter @workspace/api-server run test`) make a backup, check that it is encrypted, refuse a wrong key and a damaged file, and restore it with its sign-ins and attached files into an emptied local Supabase project.
