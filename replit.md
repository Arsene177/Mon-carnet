# Mon carnet

Mon carnet lets patients manage emergency information and control which approved doctors can view their medical records.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/medichain run dev` — run the Medichain web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — apply DB schema changes to the database selected by `DATABASE_URL`; verify the target first
- Run the database schema push after updating an existing environment; patient CM IDs, doctor credential verification, account suspension, epidemic thresholds, booklet verification references, revocable grants, profile locations, in-app notifications, and password recovery requests require the latest schema. Confirm `DATABASE_URL` points to the intended workspace or published production database before pushing.
- `pnpm --filter @workspace/api-server run seed` — seed development demo accounts and sample records
- `pnpm --filter @workspace/api-server run reset-users` — destructive one-time account reset; requires `RESET_ALL_USERS=DELETE_ALL_USERS` and `ADMIN_PASSWORD`, removes all users and linked patient data/attachments, then creates only `arsenedjonkoun5@gmail.com` as admin. Do not run the demo `seed` command afterward.
- Required env: `DATABASE_URL` — Postgres connection string
- Authentication uses `JWT_SECRET` or the existing `SESSION_SECRET` secret.
- Optional env: `CORS_ALLOWED_ORIGINS` — comma-separated origins allowed to call the API from another origin (for example a future mobile app shell). Unset means same-origin only.
- Optional env: `TRUST_PROXY` — number of reverse proxies in front of the API (default `1`), so rate limits see the real client address.
- Rate limits (in memory, per server instance): 5 failed sign-ins per account per 15 minutes, 30 sign-in attempts per address per 15 minutes, 10 registrations and 5 password recovery requests per address per hour, 300 API requests per address per minute. Never commit database dumps; `*.dump` is ignored.

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

- French and English: user-facing text is written in English inside `t("...")` (`artifacts/medichain/src/lib/i18n.ts`); French lives in `src/lib/i18n-fr.ts`, keyed by the English text, with `{0}`/`{name}` placeholders. Missing French falls back to English. French is the default unless the device prefers English; the FR/EN switch is on the sign-in page and in the header. The choice is stored in the browser and on the account (`preferredLanguage`, `PUT /api/auth/language`), and server-generated notifications use the recipient's language (`artifacts/api-server/src/lib/notification-messages.ts`). Server error messages stay in English and are translated by the web app through the same dictionary. Values stored in the database (record types, regions, statuses) stay in English and are translated only when displayed. After adding or changing UI text, run `pnpm --filter @workspace/medichain run i18n:check`.

- The shared Drizzle layer is used rather than adding a separate Prisma client, to keep one database access stack in this workspace.
- Saved medical records are immutable; a Follow-up must reference an existing record for the same patient.

## Product

Patients have a short `CM`-prefixed ID that is also the booklet access code. Each patient chooses in Access control what happens when a doctor enters it: "Give access automatically" (the default; access lasts until revoked) or "Ask me first" (the doctor's request waits for the patient to approve, with a chosen duration or until revoked, or reject it). Patients and doctors are notified in the in-app inbox; pending requests expire after 7 days, and a doctor whose request was rejected cannot ask again for 24 hours. Requests, decisions, and setting changes are written to the audit log. In automatic mode, entering the CM ID grants an approved doctor immediate access; patients can revoke a doctor's access, which rotates the CM ID to prevent the revoked doctor reconnecting with the old code. Failed code attempts are rate-limited.
Doctors without a CM ID use Emergency lookup: the patient's full name must match exactly (word order, case and accents ignored; partial names and email are not searched), a reason is required, and the date of birth is required when more than 3 active patients share the name. Only emergency details are returned. Each lookup is stored with its reason and hospital, audited, shown to the patient under Emergency lookups, and sent to the patient's inbox when emergency details were shown. Doctors are limited to 10 lookups per hour.
Patient identity: registration requires sex and a date of birth; a patient who does not know the exact date gives an age instead, stored as 1 January of the birth year with `dateOfBirthEstimated` and shown as "born around". The optional national ID card (CNI) number is normalized (upper-case, no spaces or punctuation), unique across accounts, and visible only to the patient and to doctors with granted access; it is never returned to admins, emergency lookups, or pending access requests. Doctors see sex and age next to the patient's name when opening a booklet and in emergency lookups. Admins see possible duplicate patients (same name in any word order and same birth year, unless sexes differ) in User search; accounts are never merged automatically.
Doctor account approval enables clinical access. Doctors must submit a professional medical number; an administrator manually verifies it before awarding the certified badge. Verification status is distinct from account approval.
Administrators can suspend or restore accounts without permanently deleting accounts or their medical data.
Patients and doctors can optionally maintain a Cameroon region and arrondissement in Profile. Selectors use the 360 level-3 administrative entries published by OCHA Cameroon through HDX. These are arrondissements, not a verified complete commune/council list. Source: [HDX Cameroon subnational administrative boundaries](https://data.humdata.org/dataset/cod-ab-cmr), Excel resource `cmr_admin_boundaries.xlsx`, [CC BY-IGO](https://creativecommons.org/licenses/by/3.0/igo/legalcode); the source metadata reports boundaries originally created/edited in 1987 and validity from 2019. The bundled names and codes are in `lib/api-zod/src/cameroon-arrondissements.json`.
Admins can filter patient, doctor, and hospital/clinic directories by region and arrondissement; doctor lists can be limited to uncertified accounts. Directory exports are CSV, omit patient contact details and medical records, and are capped at 5,000 entries. Hospitals are grouped by name and location from doctor profiles. Admin notices support all active non-admin users, a region, an arrondissement, or selected users. Recipient IDs are snapshotted at send time, and each account has an in-app inbox.
Admin analytics count distinct patients with suspected, probable, or confirmed structured diagnoses for epidemic-relevant diseases, using onset date (or diagnosis date when onset is missing). It compares the rolling seven-day count with the previous seven days, shows a watch signal from 80% of a per-disease threshold, and raises an in-app alert at the threshold (default: 5). Counts are network-wide because location fields are optional and may be missing; these are review signals, not confirmed outbreaks or public-health diagnoses. Analytics refresh every minute while the admin workspace is open.
Patients can print or save a complete booklet PDF from the Records page. It includes profile and emergency details plus all clinical records, and lists attached files for separate download. Each page repeats the Mon carnet watermark and a server-issued verification reference; the reference confirms issuance and the record count, not that a PDF is unaltered. The browser print dialog must be used to save the PDF.
Every signed-in account can change its password from the dashboard Profile page using the current password.
Users can request password recovery from the sign-in page. Administrators review pending requests, verify the requester through a trusted channel, and generate a random temporary password; requests do not reveal whether an email belongs to an account, and the system never uses a shared default password.
The signed-in web workspace signs out after 30 minutes without pointer, keyboard, touch, or scroll activity and synchronizes explicit sign-out across browser tabs. This is a client-side unattended-screen safeguard, not server-side token revocation: issued bearer tokens still have a seven-day expiry.
The patient overview includes an optional profile setup checklist for emergency information, date of birth, contact information, and region. Its progress is not a clinical completeness score.

## Product improvement backlog

The following proposals were reviewed for implementation. Existing foundations (expiring patient grants, access history, linked immutable follow-up records, admin inbox notices and aggregate epidemic signals, and the complete booklet PDF) should be extended rather than duplicated.

### Deferred by request

- Two-factor authentication (2FA): not implemented; plan separately with recovery, enrollment, and account-support flows.
- AI-assisted clinical summaries or recommendations: not implemented; defer until privacy, clinical validation, consent, and provider choices are designed.
- Cryptographically signed PDFs: not implemented. Patient-friendly summaries and the full booklet use server-issued verification references, but the browser print-to-PDF file itself is not digitally signed and its contents are not cryptographically bound to that reference. A true signed PDF needs a server-side PDF pipeline, protected signing-key lifecycle, signature validation UX, and review of legal acceptance.

### Not implemented in this pass

- Granular consent by record type, declared purpose, and per-record access audit. Current patient grants still cover the existing clinical record scope; add this only with a reviewed database/API migration, clear consent UX, and access-control tests.
- Appointments, medication adherence, patient/doctor follow-up tasks, and scheduled reminders. Linked follow-up records are clinical records, not task or appointment reminders. These features need a persistent workflow model, notification delivery/retry rules, and role-specific controls.
- Patient-doctor secure messaging. The inbox currently contains administrator notices only; do not treat it as a private conversation channel.
- Re-authentication prompts, device/session management, login alerts, and server-side session revocation. Current idle sign-out is browser-side only.
- Offline/PWA support, clinic/hospital integrations, white-label deployments, richer longitudinal doctor-facing patient summaries, and further operational analytics. Offline health-data storage needs an explicit encrypted storage and conflict-resolution design before implementation.
- Privacy, retention, access/deletion request procedures, legal terms, and regulatory compliance. These require an identified operating jurisdiction, retention and incident policies, and qualified legal/compliance review; do not present the app as certified or compliant until that work is complete.

Patient care summary export, structured doctor note templates, a factual summary of records visible to an authorized clinician, and aggregate network analytics by record type, region, and clinic are now implemented. Regional and clinic activity is suppressed below five distinct patients. Analytics are operational counts, not measures of care quality, and clinic names/locations depend on current clinician profile information.

The delivered improvements across the previous and current implementation passes are the optional patient setup checklist, keyboard skip navigation and focus visibility, reduced-motion support, 30-minute browser idle sign-out with cross-tab sign-out synchronization, patient-friendly care summary printing, structured clinician note templates, a factual doctor-facing patient record summary, and expanded privacy-thresholded aggregate analytics. The 2FA and AI items above are intentionally preserved as future work.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
