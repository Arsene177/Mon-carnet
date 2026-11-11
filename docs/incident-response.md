# Incident response

What to do when something goes wrong with Mon carnet: an outage, lost data, or personal data seen by someone who should not have seen it. Health data is sensitive data under Cameroon's personal data protection law (Law No. 2024/017), so a breach is a legal matter as well as a technical one.

**This plan is a draft.** The deadlines and authority to notify must be confirmed by the lawyer doing the legal review, and the contact table filled in, before launch.

## Contacts (fill in before launch)

| Role | Name | Phone | Email |
|---|---|---|---|
| Incident lead (decides, coordinates) | | | |
| Technical lead (Replit, database, code) | | | |
| Backup person for both | | | |
| Lawyer / data protection contact | | | |
| Data protection authority | | | |
| Hosting provider support | Replit | — | via the Replit dashboard |

Keep a printed copy. During an incident the app, your email or your phone may not be available.

## Severity

| Level | Examples | Response |
|---|---|---|
| **1: Critical** | Personal or health data exposed or stolen; an attacker inside an administrator or doctor account; data lost and backups damaged | Start immediately, day or night. Lead and technical lead involved. |
| **2: Serious** | App down for everyone; database unavailable; suspected but unconfirmed account takeover | Start within 1 hour. |
| **3: Minor** | One feature broken; a single locked account; one suspicious event explained quickly | Next working day. |

When unsure, choose the higher level. You can lower it later.

## Steps

### 1. Detect and record (first minutes)

Start an incident log (paper or a document outside Mon carnet) and write down, with times:

- what was noticed, by whom, and how (uptime alert, security event, user report…);
- everything you do from now on.

### 2. Contain (first hour)

Stop the damage before investigating in depth. Depending on what happened:

- **Account takeover (doctor or admin):** suspend the account in User search. This signs it out at once. Reset its two-step sign-in, and have the owner set a new password through password recovery once their identity is confirmed.
- **Patient account takeover:** suspend it, then contact the patient by a known phone number.
- **Many accounts or unknown scope:** sign everyone out by ending every session in Supabase (SQL Editor: `delete from auth.sessions;`), which stops every token on the next request. If the project's secret key may have leaked, create a new secret key in Supabase (Project Settings > API Keys), put it in `SUPABASE_SECRET_KEY`, publish, then delete the old key. Do **not** change `BACKUP_ENCRYPTION_KEY`.
- **Leaked secret (database password, API key):** rotate it in Replit immediately, then redeploy.
- **Malicious code or bad release:** roll back to the previous deployment in Replit.
- **Ongoing attack from an address:** note it from Security events; the rate limits already slow it down. Ask Replit support if it must be blocked.

Do not delete logs, security events, audit entries or backups: they are evidence.

### 3. Assess (first day)

Answer, in the incident log:

- What data was involved? Use the audit log: patients can see who accessed their booklet, and administrators can see security events and the deletion and access history.
- How many people are affected? Patients, doctors?
- Since when? Until when?
- Was the data encrypted or otherwise unreadable to the attacker? (Backups are encrypted; the live database relies on Replit's protection.)
- What is the risk for the people concerned? Discrimination, stigma, fraud, risk to health?

### 4. Notify

- **The data protection authority.** Personal data breaches must be reported to the authority set up by Law No. 2024/017, within the deadline the law sets. Confirm the deadline and form with the lawyer now, not during an incident. As a reference, the comparable European rule is 72 hours after becoming aware. Report what you know, and complete it later.
- **The people affected.** When the breach is likely to harm them (almost always for health data), tell them without delay, in clear French or English: what happened, what data, what you have done, what they should do, and who to contact. Use the in-app inbox **and** a channel that does not depend on the app (SMS, phone, email).
- **Doctors and clinics** whose patients are affected.
- **The police**, if a crime was committed (intrusion, theft, extortion).

Draft message for patients (adapt):

> **Mon carnet: security incident concerning your data**
> On [date], we discovered that [what happened]. The following information about you may have been seen by an unauthorised person: [data]. We have [what was done]. We recommend that you [actions, e.g. change your password, check who opened your booklet in Access control]. If you have questions, contact [name, phone, email]. We are sorry and are taking measures so this does not happen again.

> **Mon carnet : incident de sécurité concernant vos données**
> Le [date], nous avons découvert que [ce qui s'est passé]. Les informations suivantes vous concernant ont pu être consultées par une personne non autorisée : [données]. Nous avons [mesures prises]. Nous vous recommandons de [actions, par ex. changer votre mot de passe, vérifier qui a ouvert votre carnet dans Contrôle d'accès]. Pour toute question, contactez [nom, téléphone, e-mail]. Nous vous présentons nos excuses et prenons des mesures pour que cela ne se reproduise pas.

### 5. Recover

- Fix the cause (code, configuration, access) and deploy the fix.
- If data was lost or damaged, restore from backup following `docs/backup-and-restore.md`.
- Bring suspended accounts back only after their owners are verified.
- Watch Security events and the uptime monitor closely for the next two weeks.

### 6. Learn (within two weeks)

Write a short review: timeline, cause, what worked, what did not, and the changes you will make (with an owner and a date). No blame: the aim is to make the next incident less likely and easier to handle. Keep the review and the incident log with the record of incidents.

## Record of incidents

The law expects you to be able to show what happened and what you did. Keep one line per incident, including minor ones:

| Date | Level | Summary | People affected | Authority notified (date) | People notified (date) | Review done |
|---|---|---|---|---|---|---|
| | | | | | | |

## Practise

Once a year, walk through one scenario with the people in the contact table (for example "a doctor's phone with Mon carnet open was stolen" or "the database was deleted"). Check that contacts are current, that someone can restore a backup, and that the notification drafts still fit.
