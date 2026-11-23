// Single-use links sent by email. The token travels only in the email; the database keeps its hash.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, emailTokensTable, usersTable } from "@workspace/db";
import { languageOf } from "./notification-messages";
import { appUrl, passwordResetEmail, sendEmail, verificationEmail } from "./email";

export type EmailTokenPurpose = "VERIFY_EMAIL" | "RESET_PASSWORD";

const LIFETIME_MS: Record<EmailTokenPurpose, number> = {
  VERIFY_EMAIL: 24 * 60 * 60_000,
  RESET_PASSWORD: 60 * 60_000,
};

/** Accounts must confirm their email before signing in, unless EMAIL_VERIFICATION=off (tests, local development). */
export const emailVerificationRequired = () => process.env.EMAIL_VERIFICATION !== "off";

const hashToken = (token: string) => createHash("sha256").update(`mon-carnet-email-token:${token}`).digest("hex");

type UserRow = typeof usersTable.$inferSelect;

/** Creates a new link for the account (earlier unused links for the same purpose stop working) and emails it. */
export async function sendEmailLink(user: UserRow, purpose: EmailTokenPurpose): Promise<boolean> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.update(emailTokensTable).set({ usedAt: new Date() }).where(and(
      eq(emailTokensTable.userId, user.id),
      eq(emailTokensTable.purpose, purpose),
      isNull(emailTokensTable.usedAt),
    ));
    await tx.insert(emailTokensTable).values({ userId: user.id, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + LIFETIME_MS[purpose]) });
  });
  const language = languageOf(user.preferredLanguage);
  const page = purpose === "VERIFY_EMAIL" ? "verify-email" : "reset-password";
  const url = `${appUrl()}/${page}?token=${encodeURIComponent(token)}`;
  const message = purpose === "VERIFY_EMAIL" ? verificationEmail(language, user.name, url) : passwordResetEmail(language, user.name, url);
  return sendEmail({ email: user.email, name: user.name }, message);
}

/**
 * Spends a link: returns its account when the token is valid, unused and not expired, and marks it
 * used so it works only once. Returns null otherwise.
 */
export async function useEmailToken(token: string, purpose: EmailTokenPurpose): Promise<UserRow | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [spent] = await db.update(emailTokensTable).set({ usedAt: new Date() }).where(and(
    eq(emailTokensTable.tokenHash, hashToken(token)),
    eq(emailTokensTable.purpose, purpose),
    isNull(emailTokensTable.usedAt),
    gt(emailTokensTable.expiresAt, new Date()),
  )).returning({ userId: emailTokensTable.userId });
  if (!spent) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, spent.userId)).limit(1);
  return user && user.isActive && !user.closedAt ? user : null;
}
