# Putting Mon carnet online with Render and Supabase

This guide takes you from nothing to the app running at a web address, step by step. It takes about an hour the first time. You need:

- your Supabase project (already created);
- the GitHub account that owns `Arsene177/Mon-carnet`;
- a password manager (Bitwarden, 1Password, or your browser's) to keep three values safe.

How it fits together: **Supabase** keeps the data (database, sign-ins, lab files). **Render** runs the app on its **free plan**: one web service that serves both the website and its API. Render builds it from GitHub, using `render.yaml` and the `Dockerfile` in this repository.

The free plan has no pre-deploy step, no Shell and no scheduled jobs, so the server does those jobs itself (all set in `render.yaml`):
- `SCHEMA_PUSH_ON_START=true`: before each start, it brings the Supabase tables up to date and closes them to the public API. If that fails, it does not start.
- `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD`: on the first start it creates the first administrator. Remove them after the first sign-in.
- `BACKUP_SCHEDULE=daily` with `BACKUP_ENCRYPTION_KEY`: about once an hour it checks for a backup from the last 24 hours and makes one if needed. A failure alerts the administrators.

A free service sleeps after 15 minutes without visitors (the next visit then waits about a minute). An uptime monitor that opens `/api/readyz` every 5 minutes keeps it awake, which also keeps the hourly backup check running and stops Supabase from pausing the project (Part 5). Render's 750 free hours a month cover one service that is always on.

Never paste the values below into a chat, an email or a document. They go only into Render's forms and your password manager.

---

## Part 1. Collect four values from Supabase

Open [supabase.com/dashboard](https://supabase.com/dashboard) and click your project.

### 1.1 The database connection string (`DATABASE_URL`)

1. At the top of the page, click **Connect**.
2. In the window that opens, choose the **Connection String** tab, **Type: URI**, and under **Method** choose **Session pooler**. (Not "Direct connection": Render cannot reach it.)
3. Copy the string. It looks like `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`.
4. Replace `[YOUR-PASSWORD]` (with the brackets) by your database password.
   - Don't know it? Go to **Project Settings** (gear icon, bottom left) > **Database** > **Reset database password**, choose a long random password, and save it in your password manager.
   - If the password has characters like `@`, `#`, `/` or `?`, choose one with only letters and numbers instead, so the string works as is.
5. Save the full string in your password manager as **Mon carnet DATABASE_URL**.

While you are on **Connect**, note the region in the host name (for example `eu-central-1` = Frankfurt). You will choose the closest Render region.

### 1.2 The project URL (`SUPABASE_URL`)

**Project Settings** > **Data API** > **Project URL**, for example `https://abcdefgh.supabase.co`. Save it.

### 1.3 The secret key (`SUPABASE_SECRET_KEY`)

**Project Settings** > **API Keys**.

- If you see a section **Secret keys**: click **Add new secret key** (name it `render`), then **reveal** and copy it. It starts with `sb_secret_`.
- If you only see **Legacy API keys**: copy the **service_role** key (click **Reveal**).

Save it as **Mon carnet SUPABASE_SECRET_KEY**. This key can read and change everything: treat it like the database password.

The **publishable** / **anon** key is not needed. Do not put it anywhere.

### 1.4 How the project signs its tokens (`SUPABASE_JWT_SECRET`, often not needed)

**Project Settings** > **JWT Keys**.

- If the current key is **ECC (P-256)** or **RSA**: you need nothing. Leave `SUPABASE_JWT_SECRET` empty later.
- If it says **Legacy JWT Secret** is the current key: either click **Migrate JWT secret** / **Rotate keys** to move to the new signing keys (recommended, then leave it empty), or copy the **JWT Secret** and save it as **Mon carnet SUPABASE_JWT_SECRET**.

### 1.5 The backup key (`BACKUP_ENCRYPTION_KEY`)

This one you create yourself. In your password manager, generate a random password of **48 characters** and save it as **Mon carnet BACKUP_ENCRYPTION_KEY**. Also write it on paper and keep it somewhere safe. Without it, no backup can ever be read; never change it.

---

## Part 1b. Email sending with Brevo (10 minutes)

New accounts confirm their email address with a link, and "Forgot password?" sends a one-hour link. The emails go through [Brevo](https://www.brevo.com) (free: 300 emails a day).

1. Create a free Brevo account.
2. **Senders, Domains & Dedicated IPs** > **Senders** > **Add a sender**: the address the emails come from (for example your Gmail address) and the name `Mon carnet`. Brevo emails that address a link: click it. With your own domain later (Domains > Add a domain), emails are less likely to land in spam.
3. **SMTP & API** > **API Keys** > **Generate a new API key**, name it `mon-carnet`. Save it as **Mon carnet BREVO_API_KEY**.
4. In Render, **mon-carnet-web** > **Environment**: add `BREVO_API_KEY` (the key) and `EMAIL_FROM` (the verified sender address), then **Save Changes**.

Until these are set, the app refuses new accounts ("email is not set up"), so nobody is left with an account they cannot confirm. Accounts that existed before count as confirmed.

## Part 2. Supabase settings (5 minutes)

Still in the Supabase dashboard, left menu **Authentication**:

1. **Sign In / Providers**: turn **off** "Allow new users to sign up". The app creates accounts itself. Check that **Email** is enabled.
2. Click **Email** in the providers list: turn **off** "Secure password change", then **Save**. (The app checks the current password itself.)
3. **Rate Limits**: set "Rate limit for sign ups and sign-ins" to **1000** and "Rate limit for token refreshes" to **2000** (per 5 minutes), then **Save**. Every sign-in comes from Render's server, so the low defaults would apply to all your users together. The app keeps its own limits per person.
4. **Multi-Factor**: check that **TOTP (App Authenticator)** is enabled.

Left menu **Table Editor**: if you see tables whose names start with `medichain_`, they come from an old setup that let anyone read them. If they hold only test data, delete them (**SQL Editor**: `drop table if exists medichain_users cascade;` and so on for each `medichain_` table). Real data you want to keep: stop here and ask for help first.

Finally, **plan**: on the Free plan, Supabase pauses the project after a week without activity and keeps no daily backups. For real patients, upgrade the organization to **Pro** (Organization settings > Billing).

---

## Part 3. Create the app on Render (15 minutes)

1. Go to [render.com](https://render.com) and click **Get Started**. Sign up **with GitHub** (the account that owns `Arsene177/Mon-carnet`).
2. No payment card is needed for the free plan.
3. In the Render dashboard, click **New +** (top right) > **Blueprint**.
4. **Connect a repository**: click **Configure account** / **Connect GitHub**, allow Render to access **Arsene177/Mon-carnet** (you can choose "Only select repositories"), then pick it in the list and click **Connect**.
5. **Branch**: choose the branch to run. Use `main` once the Supabase change is merged; until then, the work branch `claude/gallant-clarke-rkoq8y`.
6. **Blueprint Name**: `mon-carnet`.
7. Render reads `render.yaml` and lists one resource, **mon-carnet-web**. Below, it shows a form for every secret. Fill them from your password manager:

   | Field | Value |
   | --- | --- |
   | `DATABASE_URL` | Mon carnet DATABASE_URL |
   | `SUPABASE_URL` | Mon carnet SUPABASE_URL |
   | `SUPABASE_SECRET_KEY` | Mon carnet SUPABASE_SECRET_KEY |
   | `BACKUP_ENCRYPTION_KEY` | Mon carnet BACKUP_ENCRYPTION_KEY |
   | `INITIAL_ADMIN_EMAIL` | the administrator's email |
   | `INITIAL_ADMIN_PASSWORD` | a long password (at least 12 characters) for the first sign-in |
   | `ALERT_WEBHOOK_URL` | optional: a Slack/Discord/Teams webhook for security alerts (`docs/monitoring.md`); otherwise empty |

   Add `SUPABASE_JWT_SECRET` afterwards (Environment) only if you saved one in 1.4.

   If your Supabase region is not Frankfurt, change `region` in `render.yaml` before this step (for example `oregon`, `ohio`, `virginia`, `singapore`): it cannot be changed later.
8. Click **Deploy Blueprint** (or **Apply**).

Render now builds the app (about 5 to 10 minutes the first time). Follow it in **mon-carnet-web** > **Events** / **Logs**. When it starts, it creates the tables in Supabase and closes them to the public API (`Locked down 16 tables` in the log), then creates the first administrator. When it says **Live**, the address is at the top of the service page, for example `https://mon-carnet.onrender.com`.

**If the deploy fails**, open **Logs**. The most common causes:
- "password authentication failed" or "ENOTFOUND": `DATABASE_URL` is wrong. Check the password and that you chose the **Session pooler**.
- "SUPABASE_URL and SUPABASE_SECRET_KEY must be set": a field was left empty.
- "signs tokens with the legacy JWT secret": see step 1.4.

To change a value later: **mon-carnet-web** > **Environment** > edit > **Save Changes**. The service redeploys by itself.

---

## Part 4. Bring over the existing data (only if there is real data on Replit)

Skip this part if the Replit app only had test accounts: start fresh in Part 5.

The lab files are in Replit's storage, which only a program running inside Replit can read, so this copy runs **one last time on Replit**. Do it before anyone uses the new Render address.

1. Tell doctors and administrators: their **password stays the same**, but they will have to **set up their authenticator app again** on the first sign-in. Patients who used two-step sign-in can turn it on again in Profile.
2. Open the Replit project. In the **Shell**, get this code: `git fetch origin && git checkout claude/gallant-clarke-rkoq8y` (or `main` once merged), then `pnpm install`.
3. In Replit **Secrets** (padlock icon): add `SOURCE_DATABASE_URL` with the **current** value of `DATABASE_URL` (copy it first). Then change `DATABASE_URL` to Mon carnet DATABASE_URL (Supabase), and add `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Keep `PRIVATE_OBJECT_DIR`. Stop the published Replit app (Deployments > Stop) so nobody writes to the old database during the copy.
4. In the Shell, a dry run, which changes nothing:

   ```bash
   pnpm --filter @workspace/api-server run migrate-to-supabase -- --dry-run
   ```

5. The copy:

   ```bash
   pnpm --filter @workspace/api-server run migrate-to-supabase
   ```

   It copies every table with the same ids, creates a Supabase sign-in for each open account, copies every lab file and checks the counts and sizes. If it stops halfway, run the same command again: it continues where it stopped. It ends with "Copy finished".
6. Run it once more: it must say "Row counts match for every table" and copy nothing new.
7. Leave the Replit project as it is for 30 days (stopped), in case something needs checking, then delete it.

---

## Part 5. First sign-in and checks (10 minutes)

1. Open your Render address and sign in with `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` (Render shows the values in **mon-carnet-web** > **Environment**). Accept the terms when asked.
2. The app asks you to set up two-step sign-in: scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 2FAS...), enter the code, and save the recovery codes in your password manager.
3. Check that the app sees your real address: open `https://<your-address>/api/client-address`. `address` must be your own public IP address (compare with [whatismyip.com](https://www.whatismyip.com)), not one starting with `10.`. If it is not, set `TRUST_PROXY` in **mon-carnet-web** > **Environment** to the number shown as `forwardedAddresses` (the proxies in front of the app), save, and check again after the redeploy. This matters: rate limits and the sign-in lock work per address.
4. If you copied data: open a patient's record and a lab file. Look at **System overview** > **Security events**.
5. In **Profile**, change your password (this ends any other session), then remove `INITIAL_ADMIN_PASSWORD` and `INITIAL_ADMIN_EMAIL` in **mon-carnet-web** > **Environment**.
6. The first backup is made about 2 minutes after the first start. Check it in Supabase > **Storage** > `backups`, or in the Render log ("Daily backup made").
7. Set up an uptime monitor, for example [UptimeRobot](https://uptimerobot.com) (free): **New monitor** > HTTP(s) > URL `https://<your-address>/api/readyz` > every 5 minutes, with email alerts. It keeps the free service awake and tells you when the site is down.
8. Turn on failure emails: Render **Account Settings** > **Notifications** > notify on failed deploys.

---

## Afterwards

- **Updates**: every push to the chosen branch redeploys automatically; the pre-deploy step updates the Supabase tables first. If it fails, the old version keeps running and the reason is in **Events**.
- **Your own domain** (for example `app.moncarnet.cm`): **mon-carnet** > **Settings** > **Custom Domains** > **Add Custom Domain**, then add the DNS record Render shows at your domain registrar. HTTPS is set up automatically.
- **Weekly**: download the newest backup (Supabase > **Storage** > `backups`) and keep a copy outside Supabase and Render, for example on an external drive (`docs/backup-and-restore.md`).
- **Legal**: the privacy policy must name the hosts (Render for the app, Supabase for the data) and the data region before launch.
- The settings, the other variables and what is stored where: `docs/supabase.md`.
