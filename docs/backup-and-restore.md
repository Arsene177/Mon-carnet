# Backup and restore

Mon carnet holds medical records that cannot be recreated. This runbook says how backups are made, where they are kept, and how to bring the service back from one. It is written for whoever operates the production deployment.

## What a backup contains

One encrypted file (`mon-carnet-backup-<date>.mcbk`) with:

- the whole database (accounts, emergency information, medical records, coded diagnoses, access grants, audit log, notifications), taken from a single consistent snapshot by `pg_dump`;
- every attached file (scans, lab results) in private object storage that a record points to;
- a manifest with the row count of every table and a SHA-256 checksum of every attached file, so a restore can prove it is complete.

The file is encrypted with AES-256-GCM using a key derived from `BACKUP_ENCRYPTION_KEY`. Without that key a backup cannot be read by anyone, including you. A damaged or altered file is detected and refused.

## Targets

| | Target | Why |
|---|---|---|
| Recovery point (data you can lose) | at most 24 hours | one backup per day |
| Recovery time (time to be back up) | under 4 hours | restore takes minutes; most time is deciding and checking |
| Copies | 3 copies, 2 kinds of storage, 1 away from Replit | the "3-2-1" rule |
| Restore drill | every 3 months | a backup that was never restored is not known to work |

## One-time setup

1. **Create the encryption key.** On any computer run:

   ```bash
   openssl rand -base64 48
   ```

   Add the result as a secret named `BACKUP_ENCRYPTION_KEY` in the Replit deployment. Also store it in a password manager **and** on paper in a safe place. If this key is lost, every backup becomes unreadable. Never change it; if it must change (for example it leaked), keep the old key as well, because older backups still need it.

2. **Schedule the daily backup.** In Replit, create a Scheduled Deployment for this project that runs once a day at a quiet hour (for example 02:00 Africa/Douala) with the command:

   ```bash
   pnpm --filter @workspace/api-server run backup -- --upload --out /tmp/backups
   ```

   It needs the same secrets as the app: `DATABASE_URL` (the production database), `PRIVATE_OBJECT_DIR`, and `BACKUP_ENCRYPTION_KEY`. `--upload` stores the file in the project's object storage under `backups/`. The command exits with an error if anything fails, so the scheduled run shows as failed. Check the run history weekly.

3. **Keep a copy away from Replit (weekly).** Object storage is a second place, but it belongs to the same provider. Once a week, download the newest backup to a computer and copy it to a second location that does not depend on Replit, for example an external drive kept off-site or another cloud storage account. The file is encrypted, so it is safe to store there. To download it from a Replit shell:

   ```bash
   pnpm --filter @workspace/api-server run backup:download -- --name mon-carnet-backup-<date>.mcbk --out backups
   ```

   Keep daily backups for 30 days and one per month for as long as the medical-record retention period requires (still to be set by the legal review). Delete older files from object storage by hand; nothing deletes them automatically.

4. **Also use the hosting provider's protection.** If your Replit plan offers point-in-time restore or history for the production database, keep it switched on. It is quicker for small mistakes but does not replace these backups: it does not cover attached files, and it lives with the same provider.

## Check that a backup is good

```bash
pnpm --filter @workspace/api-server run backup:verify -- --file backups/mon-carnet-backup-<date>.mcbk
```

This decrypts the file, checks every attached file against its checksum and checks that the database dump can be read. It changes nothing.

## Restore

Restoring replaces data, so go slowly and write down what you do.

1. **Decide what you are restoring and why.** Note the time of the incident and pick the newest backup made before it. Data entered after that backup will be lost; collect what you can (for example from doctors) to enter again.
2. **Stop writes.** Pause the production deployment, or put up a maintenance notice, so nobody adds data while you restore.
3. **Restore into a new, empty database first.** Create a fresh Postgres database, then:

   ```bash
   pnpm --filter @workspace/api-server run backup:restore -- --file backups/mon-carnet-backup-<date>.mcbk --target-database-url "postgres://…/new_database"
   ```

   The tool refuses a database that already holds Mon carnet data unless you add `--replace-existing-data`, and it checks that every table has exactly the row count recorded in the backup.
4. **Check the restored data.** Point a test copy of the app at the new database and sign in with a test account. Open one patient's records.
5. **Switch production to it.** Either change the production `DATABASE_URL` to the restored database, or restore again into the production database with `--replace-existing-data`.
6. **Put attached files back if they were lost.** Run the restore with `--restore-attachments` where `PRIVATE_OBJECT_DIR` points at the production bucket. Files are uploaded to the same paths, so records find them again.
7. **Resume service and record the incident** (see `docs/incident-response.md` when it exists): what happened, which backup was used, what data was lost, who was told.

## Restore drill (every 3 months)

1. Download the newest backup.
2. Run `backup:verify` on it.
3. Restore it into a new empty database (step 3 above) and check the data (step 4).
4. Delete the test database.
5. Add a line below.

| Date | Backup used | Result | Time taken | Done by |
|---|---|---|---|---|
| | | | | |

## Requirements and limits

- The backup tool needs the PostgreSQL 16 client tools (`pg_dump`, `pg_restore`, version at least that of the database server) and `tar`. They are part of this Replit project (`postgresql-16` module).
- A backup holds the whole database in one file. That is fine for years at the current size; revisit if the file grows past a few gigabytes.
- Passwords are stored hashed and two-step sign-in secrets encrypted with `MFA_ENCRYPTION_KEY`. Restoring into a deployment with a different `MFA_ENCRYPTION_KEY` (or `JWT_SECRET` when that key is not set) means every two-step sign-in must be reset.
- The automated tests (`pnpm --filter @workspace/api-server run test`) make a backup, check that it is encrypted, refuse a wrong key and a damaged file, and restore it into an empty database with its attached files.
