# Monitoring

How you find out that Mon carnet is down or under attack, and what to set up so you hear about it without looking.

## What the app watches by itself

Security events are recorded in the database and listed for administrators under **System overview › Security events** (newest 200, kept 12 months).

| Event | When | Level |
|---|---|---|
| Account locked | 5 wrong passwords or two-step codes for one account within 15 minutes | warning |
| Sign-in flood | more than 30 sign-in attempts from one network address within 15 minutes | warning |
| Emergency lookup limit | a doctor reaches 10 emergency name lookups in an hour | warning |
| Unusual record access | a doctor opens the records of 20 or more different patients within an hour (`UNUSUAL_ACCESS_PATIENTS_PER_HOUR`) | warning |
| Server error | an unexpected error on a request (route only, no data) | warning |
| Two-step sign-in reset | an administrator resets someone's two-step sign-in | warning |
| Temporary password | an administrator issues a temporary password | warning |
| Account suspended / restored | an administrator suspends or restores an account | warning / info |
| Account erased / closed | an administrator acts on a deletion request | warning / info |

**Warnings** also:

- appear in the inbox of every active administrator (except the one who did the action), in their language;
- are sent to `ALERT_WEBHOOK_URL` if it is set (see below).

The same alert is sent at most once every 15 minutes for the same account, address, doctor or route, so an attack does not bury you in messages. Alerts sent outside the app never contain names, emails or health data. They say what kind of thing happened and point to the Security events screen.

Unusual record access is a signal to look at, not proof of misuse. A doctor on an emergency shift may legitimately open many files. Check the patients' access history and ask the doctor.

## Set up (once)

### 1. Uptime monitor

Use a free uptime service (for example UptimeRobot, Better Stack or Freshping) to check every minute:

```
https://<your-domain>/api/readyz
```

It answers `200 {"status":"ok","database":"ok"}` when the app and its database work, and `503` when the database does not answer within 3 seconds. Set the monitor to alert you by email and SMS or app notification after two failed checks in a row. Add a second person if you can.

`/api/healthz` only says the web server is running. Use `/api/readyz` for monitoring.

### 2. Alert webhook (recommended)

Inbox alerts are only seen by someone who signs in. To get them on your phone, create an incoming webhook and set it as the deployment secret `ALERT_WEBHOOK_URL`:

- **Slack**: an "Incoming Webhook" for a private channel.
- **Discord**: Server settings › Integrations › Webhooks.
- **Microsoft Teams**: a "Post to a channel when a webhook request is received" workflow.
- **Email**: any webhook-to-email service, or Zapier/Make.

The app sends JSON with `text` (Slack, Teams) and `content` (Discord) holding one line such as:

```
[Mon carnet] WARNING: An account was locked after repeated wrong passwords or codes. (ACCOUNT_LOCKED, 2026-11-10T22:23:13Z) See System overview › Security events.
```

Test it: try to sign in six times with a wrong password on a test account (the sixth attempt is blocked). A message should arrive within a few seconds.

### 3. Replit deployment logs

The server writes one JSON line per request (method, route, status, time; never the body or the `Authorization` header) and logs every server error with its stack trace. Look at them in the Replit deployment's Logs tab when something goes wrong.

### 4. Backups

The daily backup (see `docs/backup-and-restore.md`) fails loudly if it cannot run. Check the scheduled deployment's run history every week.

## Weekly check (5 minutes)

1. System overview › Security events: anything unexpected? Locked accounts you cannot explain, unusual record access, admin actions nobody remembers doing?
2. The uptime service's report: any outages?
3. The backup schedule: did every run succeed?
4. GitHub: did the latest checks on `main` pass?

If anything looks like a breach, follow `docs/incident-response.md`.

## Limits

- Alert throttling and rate limits are kept in memory per server instance. With several instances (autoscale), each sends its own alert and counts attempts separately.
- Security events show the network address seen by the server. Behind proxies this depends on `TRUST_PROXY` being right.
- Nothing watches the hosting provider itself (Replit outages, certificate expiry). The uptime monitor will notice the effect.
