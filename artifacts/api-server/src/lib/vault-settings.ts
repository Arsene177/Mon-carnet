// Settings kept in Supabase Vault (encrypted secrets in the database), for when the host's own
// environment variables cannot be set. Each Vault secret named `mon_carnet.<NAME>` fills
// process.env.<NAME>, but only for the names listed below, and never over a value the host already
// set: the host's environment variables always win.
//
// Add or change one in the Supabase dashboard (Project Settings > Vault > Add new secret; name
// for example `mon_carnet.BREVO_API_KEY`), then restart the app. Database connection settings and
// Supabase keys cannot come from here: the app needs them to reach the database in the first place.
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

export const VAULT_SETTING_NAMES = [
  "BREVO_API_KEY",
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "APP_URL",
  "TRUST_PROXY",
  "ALERT_WEBHOOK_URL",
  "RECORD_EDIT_WINDOW_HOURS",
  "UNUSUAL_ACCESS_PATIENTS_PER_HOUR",
] as const;

const PREFIX = "mon_carnet.";

/** Copies allowed settings from Supabase Vault into process.env. Returns the names it set (never values). */
export async function loadVaultSettings(): Promise<string[]> {
  let rows: Array<{ name: string; value: string }>;
  try {
    const result = await db.execute<{ name: string; value: string }>(sql`
      select name, decrypted_secret as value from vault.decrypted_secrets where name like ${`${PREFIX}%`}`);
    rows = result.rows;
  } catch (err) {
    // No Vault (a plain Postgres database): nothing to load.
    logger.warn({ err }, "Settings in Supabase Vault could not be read");
    return [];
  }
  const loaded: string[] = [];
  for (const { name, value } of rows) {
    const key = name.slice(PREFIX.length);
    if (!(VAULT_SETTING_NAMES as readonly string[]).includes(key)) {
      logger.warn({ name }, "Ignored a Vault secret that is not an allowed setting");
      continue;
    }
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    process.env[key] = value.trim();
    loaded.push(key);
  }
  if (loaded.length) logger.info({ settings: loaded }, "Settings loaded from Supabase Vault");
  return loaded;
}
