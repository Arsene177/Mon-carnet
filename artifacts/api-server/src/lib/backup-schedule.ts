// Daily encrypted backups made by the API server itself, for hosts without scheduled jobs (Render's
// free plan). With BACKUP_SCHEDULE=daily the server checks about once an hour whether the backup
// bucket holds a backup from the last 24 hours and, if not, runs the backup tool (dist/backup.mjs,
// the same as `pnpm --filter @workspace/api-server run backup -- --upload`). A failure is a security
// event, so administrators are alerted. Needs BACKUP_ENCRYPTION_KEY and pg_dump in the image.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";
import { recordSecurityEvent } from "./security-events";
import { listTopLevelObjects } from "./supabase";

const DAY_MS = 24 * 60 * 60_000;
const backupBucket = () => process.env.SUPABASE_BACKUP_BUCKET ?? "backups";
let running = false;

/** The time in a backup file name such as mon-carnet-backup-2026-11-23T01-00-00-000Z.mcbk. */
export function backupTime(name: string): number | null {
  const match = /^mon-carnet-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.mcbk$/.exec(name);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : null;
}

async function newestBackupTime(): Promise<number | null> {
  try {
    const times = (await listTopLevelObjects(backupBucket())).map((item) => backupTime(item.name)).filter((time): time is number => time !== null);
    return times.length ? Math.max(...times) : null;
  } catch (error) {
    // The bucket is created by the first upload.
    if (error instanceof Error && /not found/i.test(error.message)) return null;
    throw error;
  }
}

function runBackupTool(): Promise<{ code: number | null; output: string }> {
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(serverDir, "backup.mjs"), "backup", "--upload", "--out", "/tmp/mon-carnet-backups", "--keep", "1"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => resolve({ code: null, output: error.message }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

export async function backupIfDue(now = Date.now()): Promise<"made" | "not-due" | "failed" | "busy"> {
  if (running) return "busy";
  running = true;
  try {
    const newest = await newestBackupTime();
    if (newest !== null && now - newest < DAY_MS) return "not-due";
    const { code, output } = await runBackupTool();
    if (code === 0) {
      logger.info({ result: output.trim().split("\n").filter((line) => /Backup written|Uploaded/.test(line)) }, "Daily backup made");
      return "made";
    }
    // The tool's messages name the step that failed, never data or secrets.
    logger.error({ code, output: output.trim().split("\n").slice(-5) }, "Daily backup failed");
    await recordSecurityEvent({ type: "BACKUP_FAILED", severity: "warning", details: { step: output.trim().split("\n").at(-1)?.slice(0, 300) ?? null }, subject: "daily-backup", dedupe: true });
    return "failed";
  } catch (error) {
    logger.error({ err: error }, "Daily backup check failed");
    await recordSecurityEvent({ type: "BACKUP_FAILED", severity: "warning", details: { step: error instanceof Error ? error.message.slice(0, 300) : "check" }, subject: "daily-backup", dedupe: true });
    return "failed";
  } finally {
    running = false;
  }
}

export function startBackupSchedule(): void {
  if (process.env.BACKUP_SCHEDULE !== "daily") return;
  if (!process.env.BACKUP_ENCRYPTION_KEY) {
    logger.error("BACKUP_SCHEDULE=daily but BACKUP_ENCRYPTION_KEY is not set: no backups are made");
    return;
  }
  const firstCheckMs = Number(process.env.BACKUP_FIRST_CHECK_SECONDS ?? 120) * 1000;
  setTimeout(() => void backupIfDue(), firstCheckMs).unref();
  setInterval(() => void backupIfDue(), 60 * 60_000).unref();
  logger.info("Daily backups are on (checked every hour)");
}
