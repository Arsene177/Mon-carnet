import type { Request } from "express";
import { rateLimit, type Options } from "express-rate-limit";
import { recordSecurityEvent, type SecurityEventType } from "./security-events";

const FIFTEEN_MINUTES = 15 * 60_000;
const ONE_HOUR = 60 * 60_000;

function limiter(options: Partial<Options>) {
  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...options,
  });
}

/** Answers like the default handler, and records a security event the first time a key is blocked. */
function reportWhenBlocked(type: SecurityEventType, describe: (req: Request) => { subject: string; userId?: number; details: Record<string, string | number | null> }): Partial<Options> {
  return {
    handler: (req, res, _next, options) => {
      const { subject, userId, details } = describe(req);
      void recordSecurityEvent({ type, severity: "warning", userId, ipAddress: req.ip ?? null, details, subject, dedupe: true });
      res.status(options.statusCode).json(options.message);
    },
  };
}

function emailKey(req: Request): string {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  return email ? `email:${email}` : `ip:${req.ip}`;
}

const tooManyLogins = {
  error: "Too many sign-in attempts. Wait 15 minutes and try again.",
};

/** Caps all sign-in attempts from one network address. */
export const loginIpLimiter = limiter({
  windowMs: FIFTEEN_MINUTES,
  limit: 30,
  message: tooManyLogins,
  ...reportWhenBlocked("SIGN_IN_FLOOD", (req) => ({ subject: req.ip ?? "", details: { ip: req.ip ?? null } })),
});

/** Locks one account after repeated failed passwords, whatever address they come from. */
export const loginAccountLimiter = limiter({
  windowMs: FIFTEEN_MINUTES,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: emailKey,
  message: tooManyLogins,
  ...reportWhenBlocked("ACCOUNT_LOCKED", (req) => {
    const key = emailKey(req);
    return { subject: key, details: { email: key.startsWith("email:") ? key.slice(6) : null } };
  }),
});

export const registrationLimiter = limiter({
  windowMs: ONE_HOUR,
  limit: 10,
  message: { error: "Too many accounts created from this network. Try again later." },
});

export const passwordResetLimiter = limiter({
  windowMs: ONE_HOUR,
  limit: 5,
  message: { error: "Too many password recovery requests. Try again later." },
});

/** Public booklet verification lookups. */
export const verificationLimiter = limiter({
  windowMs: 60_000,
  limit: 30,
  message: { error: "Too many verification requests. Wait a minute and try again." },
});

/** General ceiling for all API traffic from one address. */
export const apiLimiter = limiter({
  windowMs: 60_000,
  limit: 300,
  message: { error: "Too many requests. Wait a minute and try again." },
});

/** Emergency name lookups per doctor account. Use after requireAuth. */
export const emergencyLookupLimiter = limiter({
  windowMs: ONE_HOUR,
  limit: 10,
  keyGenerator: (req) => `doctor:${req.currentUser?.id ?? req.ip}`,
  message: { error: "You have made 10 emergency lookups in the last hour. Ask the patient for their CM ID, or try again later." },
  ...reportWhenBlocked("EMERGENCY_LOOKUP_LIMIT", (req) => ({
    subject: String(req.currentUser?.id ?? req.ip),
    userId: req.currentUser?.id,
    details: { doctorName: req.currentUser?.name ?? null, hospital: req.currentUser?.hospitalName ?? null },
  })),
});
