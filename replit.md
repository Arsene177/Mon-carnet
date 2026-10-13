# Medichain

Medichain lets patients manage emergency information and control which approved doctors can view their medical records.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/medichain run dev` — run the Medichain web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Run the database schema push after updating an existing environment; patient display IDs, secure sharing codes, and revocable, non-expiring grants require the latest schema.
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

Patients have a short `CM`-prefixed display ID and a separate high-entropy sharing code. Sharing the private code with a verified doctor grants immediate, non-expiring access to the medical booklet. Patients can revoke a doctor's access at any time; doing so rotates the sharing code. Doctors can search patients by name to view available emergency information.
Every signed-in account can change its password from the dashboard Profile page using the current password.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
