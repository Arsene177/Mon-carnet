# Mon carnet

Mon carnet lets patients manage emergency information and control which approved doctors can view their medical records.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/medichain run dev` — run the Medichain web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — apply DB schema changes to the database selected by `DATABASE_URL`; verify the target first
- Run the database schema push after updating an existing environment; patient CM IDs, doctor credential verification, account suspension, epidemic thresholds, booklet verification references, and revocable grants require the latest schema. Confirm `DATABASE_URL` points to the intended workspace or published production database before pushing.
- `pnpm --filter @workspace/api-server run seed` — seed development demo accounts and sample records
- `pnpm --filter @workspace/api-server run reset-users` — destructive one-time account reset; requires `RESET_ALL_USERS=DELETE_ALL_USERS` and `ADMIN_PASSWORD`, removes all users and linked patient data/attachments, then creates only `arsenedjonkoun5@gmail.com` as admin. Do not run the demo `seed` command afterward.
- Required env: `DATABASE_URL` — Postgres connection string
- Authentication uses `JWT_SECRET` or the existing `SESSION_SECRET` secret.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM (the shared database layer provided by this workspace)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- The shared Drizzle layer is used rather than adding a separate Prisma client, to keep one database access stack in this workspace.
- Saved medical records are immutable; a Follow-up must reference an existing record for the same patient.

## Product

Patients have a short `CM`-prefixed ID that is also the booklet access code. Entering it grants an approved doctor immediate access; patients can revoke a doctor's access, which rotates the CM ID to prevent the revoked doctor reconnecting with the old code. Failed code attempts are rate-limited.
Doctor account approval enables clinical access. Doctors must submit a professional medical number; an administrator manually verifies it before awarding the certified badge. Verification status is distinct from account approval.
Administrators can suspend or restore accounts without permanently deleting accounts or their medical data.
Admin analytics count distinct patients with suspected, probable, or confirmed structured diagnoses for epidemic-relevant diseases, using onset date (or diagnosis date when onset is missing). It compares the rolling seven-day count with the previous seven days, shows a watch signal from 80% of a per-disease threshold, and raises an in-app alert at the threshold (default: 5). Counts are network-wide because patient geography is not currently stored; these are review signals, not confirmed outbreaks or public-health diagnoses. Analytics refresh every minute while the admin workspace is open.
Patients can print or save a complete booklet PDF from the Records page. It includes profile and emergency details plus all clinical records, and lists attached files for separate download. Each page repeats the Mon carnet watermark and a server-issued verification reference; the reference confirms issuance and the record count, not that a PDF is unaltered. The browser print dialog must be used to save the PDF.
Every signed-in account can change its password from the dashboard Profile page using the current password.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
