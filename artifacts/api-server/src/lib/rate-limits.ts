import type { Request } from "express";
import { rateLimit, type Options } from "express-rate-limit";

const FIFTEEN_MINUTES = 15 * 60_000;
const ONE_HOUR = 60 * 60_000;

function limiter(options: Partial<Options>) {
  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...options,
  });
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
});

/** Locks one account after repeated failed passwords, whatever address they come from. */
export const loginAccountLimiter = limiter({
  windowMs: FIFTEEN_MINUTES,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: emailKey,
  message: tooManyLogins,
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
});
