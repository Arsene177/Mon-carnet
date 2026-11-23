// The pages behind the links sent by email: confirming an email address, asking for a new
// confirmation email, and choosing a new password.
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { auditEventsTable, db, usersTable } from "@workspace/db";
import {
  ResendVerificationEmailBody,
  ResendVerificationEmailResponse,
  ResetPasswordWithEmailLinkBody,
  ResetPasswordWithEmailLinkResponse,
  VerifyEmailBody,
  VerifyEmailResponse,
} from "@workspace/api-zod";
import { sendEmailLink, useEmailToken } from "../lib/email-tokens";
import { emailConfigured } from "../lib/email";
import { endSessions } from "../lib/medichain-auth";
import { SupabaseError, setAuthPassword } from "../lib/supabase";
import { invalidBody } from "./medichain";

const router: IRouter = Router();
const INVALID_LINK = "This link is invalid, already used or expired. Ask for a new one.";

router.post("/auth/verify-email", async (req, res): Promise<void> => {
  const parsed = VerifyEmailBody.safeParse(req.body);
  const user = parsed.success ? await useEmailToken(parsed.data.token, "VERIFY_EMAIL") : null;
  if (!user) {
    invalidBody(res, INVALID_LINK);
    return;
  }
  await db.update(usersTable).set({ emailVerifiedAt: user.emailVerifiedAt ?? new Date() }).where(eq(usersTable.id, user.id));
  await db.insert(auditEventsTable).values({ actorUserId: user.id, action: "EMAIL_VERIFIED", entityType: "account", entityId: user.id });
  res.json(VerifyEmailResponse.parse({ verified: true }));
});

router.post("/auth/verification-email", async (req, res): Promise<void> => {
  const parsed = ResendVerificationEmailBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter a valid email address.");
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (emailConfigured() && user && !user.emailVerifiedAt && user.isActive && !user.closedAt) {
    await sendEmailLink(user, "VERIFY_EMAIL");
  }
  // The same answer whether or not the account exists or is already confirmed.
  res.status(202).json(ResendVerificationEmailResponse.parse({
    message: "If an account with this email is waiting for confirmation, we have sent a new link.",
  }));
});

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const parsed = ResetPasswordWithEmailLinkBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, parsed.error.issues.some((issue) => issue.path[0] === "newPassword") ? "Choose a password of at least 8 characters." : INVALID_LINK);
    return;
  }
  const user = await useEmailToken(parsed.data.token, "RESET_PASSWORD");
  if (!user || !user.authUserId) {
    invalidBody(res, INVALID_LINK);
    return;
  }
  try {
    // Ends every session of the account.
    await setAuthPassword(user.authUserId, parsed.data.newPassword);
  } catch (error) {
    if (error instanceof SupabaseError && error.code === "weak_password") {
      invalidBody(res, "Choose a stronger password of at least 8 characters.");
      return;
    }
    throw error;
  }
  await endSessions(user.authUserId);
  // The link proved the person reads this mailbox, so the address counts as confirmed.
  await db.update(usersTable).set({ passwordHash: null, emailVerifiedAt: user.emailVerifiedAt ?? new Date() }).where(eq(usersTable.id, user.id));
  await db.insert(auditEventsTable).values({ actorUserId: user.id, action: "PASSWORD_RESET_BY_EMAIL", entityType: "account", entityId: user.id });
  res.json(ResetPasswordWithEmailLinkResponse.parse({ message: "Your password is changed. Sign in with it; every other session has ended." }));
});

export default router;
