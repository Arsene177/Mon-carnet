// Security monitoring: records suspicious or sensitive activity and alerts administrators.
//
// Warnings and critical events go to every active administrator's in-app inbox and, when
// ALERT_WEBHOOK_URL is set, to that webhook (Slack, Discord, Microsoft Teams workflow, or an
// email-forwarding service). Alerts of the same kind are sent at most once per 15 minutes per
// subject, so an attack does not flood anyone. Alerts never contain names, emails or health data:
// they say what happened and point to Security events in the admin workspace.
import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db, notificationsTable, securityEventsTable, usersTable } from "@workspace/db";
import { logger } from "./logger";
import { languageOf } from "./notification-messages";

export type SecuritySeverity = "info" | "warning" | "critical";

export type SecurityEventType =
  | "ACCOUNT_LOCKED"
  | "SIGN_IN_FLOOD"
  | "EMERGENCY_LOOKUP_LIMIT"
  | "UNUSUAL_RECORD_ACCESS"
  | "SERVER_ERROR"
  | "MFA_RESET_BY_ADMIN"
  | "TEMPORARY_PASSWORD_ISSUED"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_RESTORED"
  | "ACCOUNT_ERASED"
  | "ACCOUNT_CLOSED";

type Details = Record<string, string | number | null>;

/** What an alert says, in each language. No personal data. */
const ALERT_TEXT: Record<SecurityEventType, { en: string; fr: string }> = {
  ACCOUNT_LOCKED: { en: "An account was locked after repeated wrong passwords or codes.", fr: "Un compte a été bloqué après plusieurs mots de passe ou codes erronés." },
  SIGN_IN_FLOOD: { en: "Many sign-in attempts are coming from one network address.", fr: "De nombreuses tentatives de connexion viennent d’une même adresse réseau." },
  EMERGENCY_LOOKUP_LIMIT: { en: "A doctor reached the emergency lookup limit.", fr: "Un médecin a atteint la limite de recherches d’urgence." },
  UNUSUAL_RECORD_ACCESS: { en: "A doctor opened an unusual number of patient records within an hour.", fr: "Un médecin a ouvert un nombre inhabituel de dossiers de patients en une heure." },
  SERVER_ERROR: { en: "The server had an unexpected error.", fr: "Le serveur a rencontré une erreur inattendue." },
  MFA_RESET_BY_ADMIN: { en: "An administrator reset an account's two-step sign-in.", fr: "Un administrateur a réinitialisé la validation en deux étapes d’un compte." },
  TEMPORARY_PASSWORD_ISSUED: { en: "An administrator issued a temporary password.", fr: "Un administrateur a délivré un mot de passe temporaire." },
  ACCOUNT_SUSPENDED: { en: "An administrator suspended an account.", fr: "Un administrateur a suspendu un compte." },
  ACCOUNT_RESTORED: { en: "An administrator restored a suspended account.", fr: "Un administrateur a rétabli un compte suspendu." },
  ACCOUNT_ERASED: { en: "An administrator erased an account and its data.", fr: "Un administrateur a effacé un compte et ses données." },
  ACCOUNT_CLOSED: { en: "An administrator closed an account.", fr: "Un administrateur a fermé un compte." },
};

const ALERT_INTERVAL_MS = 15 * 60_000;
const lastAlertAt = new Map<string, number>();

/** True when an alert for this kind and subject was not sent in the last 15 minutes (per server instance). */
function shouldAlert(key: string, now = Date.now()): boolean {
  const last = lastAlertAt.get(key);
  if (last !== undefined && now - last < ALERT_INTERVAL_MS) return false;
  lastAlertAt.set(key, now);
  if (lastAlertAt.size > 5000) {
    for (const [entry, at] of lastAlertAt) if (now - at >= ALERT_INTERVAL_MS) lastAlertAt.delete(entry);
  }
  return true;
}

async function notifyAdministrators(type: SecurityEventType, severity: SecuritySeverity, excludeUserId: number | null): Promise<void> {
  const admins = await db
    .select({ id: usersTable.id, language: usersTable.preferredLanguage })
    .from(usersTable)
    .where(and(eq(usersTable.role, "ADMIN"), eq(usersTable.isActive, true)));
  const recipients = admins.filter((admin) => admin.id !== excludeUserId);
  if (!recipients.length) return;
  const batchId = randomUUID();
  await db.insert(notificationsTable).values(recipients.map((admin) => {
    const language = languageOf(admin.language);
    const text = ALERT_TEXT[type][language];
    return language === "fr"
      ? { batchId, senderId: null, recipientId: admin.id, title: severity === "critical" ? "Alerte de sécurité critique" : "Alerte de sécurité", body: `${text} Consultez Vue d’ensemble du système › Événements de sécurité pour les détails.` }
      : { batchId, senderId: null, recipientId: admin.id, title: severity === "critical" ? "Critical security alert" : "Security alert", body: `${text} See System overview › Security events for details.` };
  }));
}

async function postWebhook(type: SecurityEventType, severity: SecuritySeverity, at: Date): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const text = `[Mon carnet] ${severity.toUpperCase()}: ${ALERT_TEXT[type].en} (${type}, ${at.toISOString()}) See System overview › Security events.`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // "text" is read by Slack and Teams workflows, "content" by Discord.
    body: JSON.stringify({ text, content: text, type, severity, at: at.toISOString() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Alert webhook answered ${response.status}`);
}

/**
 * Records a security event and, for warnings and critical events, alerts administrators.
 * Never throws: monitoring must not break the request that triggered it.
 * `subject` groups repeated events for throttling (an account, an address, a doctor).
 */
export async function recordSecurityEvent(event: {
  type: SecurityEventType;
  severity: SecuritySeverity;
  userId?: number | null;
  ipAddress?: string | null;
  details?: Details;
  subject?: string;
  actingAdminId?: number | null;
  /** Record at most one event per subject every 15 minutes (for events that repeat on every request). */
  dedupe?: boolean;
}): Promise<void> {
  try {
    if (event.dedupe && !shouldAlert(`record:${event.type}:${event.subject ?? ""}`)) return;
    const [row] = await db.insert(securityEventsTable).values({
      type: event.type,
      severity: event.severity,
      userId: event.userId ?? null,
      ipAddress: event.ipAddress ?? null,
      details: event.details ?? {},
    }).returning({ createdAt: securityEventsTable.createdAt });
    logger.warn({ securityEvent: event.type, severity: event.severity }, "Security event");
    if (event.severity === "info" || !shouldAlert(`${event.type}:${event.subject ?? ""}`)) return;
    await Promise.allSettled([
      notifyAdministrators(event.type, event.severity, event.actingAdminId ?? null),
      postWebhook(event.type, event.severity, row?.createdAt ?? new Date()),
    ]).then((results) => results.forEach((result) => {
      if (result.status === "rejected") logger.error({ err: result.reason }, "Security alert could not be delivered");
    }));
  } catch (err) {
    logger.error({ err }, "Security event could not be recorded");
  }
}

/** Deletes security events older than 12 months. */
export async function purgeOldSecurityEvents(): Promise<void> {
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60_000);
  await db.delete(securityEventsTable).where(lt(securityEventsTable.createdAt, cutoff));
}

/** Doctors who open this many different patients' records within an hour are reported. */
export function unusualAccessThreshold(): number {
  const value = Number(process.env.UNUSUAL_ACCESS_PATIENTS_PER_HOUR ?? 20);
  return Number.isInteger(value) && value > 0 ? value : 20;
}
