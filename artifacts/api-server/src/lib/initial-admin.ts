// Creates the first administrator account when the server starts, for hosts where no command can be
// run by hand (Render's free plan has no Shell). Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD
// (and optionally INITIAL_ADMIN_NAME); nothing happens once any administrator exists. After the first
// sign-in, change the password in Profile and remove the two variables.
import { eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { logger } from "./logger";
import { SupabaseError, createAuthUser } from "./supabase";

export async function ensureInitialAdmin(): Promise<void> {
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !password) return;
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "ADMIN")).limit(1);
  if (existing) {
    logger.warn("INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD are still set but an administrator exists: remove them");
    return;
  }
  if (password.length < 12) throw new Error("INITIAL_ADMIN_PASSWORD must be at least 12 characters.");
  let authUserId: string;
  try {
    authUserId = await createAuthUser(email, password);
  } catch (error) {
    if (!(error instanceof SupabaseError && error.code === "email_exists")) throw error;
    // An earlier start created the sign-in and stopped before the account row.
    const found = await db.execute<{ id: string }>(sql`select id from auth.users where lower(email) = ${email} limit 1`);
    if (!found.rows[0]) throw error;
    authUserId = found.rows[0].id;
  }
  await db.insert(usersTable).values({
    email,
    authUserId,
    role: "ADMIN",
    name: process.env.INITIAL_ADMIN_NAME?.trim() || "Administrator",
    isActive: true,
  }).onConflictDoNothing();
  logger.info({ email }, "Created the first administrator account; change its password after signing in and remove INITIAL_ADMIN_PASSWORD");
}
