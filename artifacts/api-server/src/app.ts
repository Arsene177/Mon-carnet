import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { recordSecurityEvent } from "./lib/security-events";
import {
  apiLimiter,
  loginAccountLimiter,
  loginIpLimiter,
  passwordResetLimiter,
  registrationLimiter,
  verificationLimiter,
} from "./lib/rate-limits";

const app: Express = express();

// The API runs behind the host's reverse proxy (Render's load balancer). Trusting it gives rate
// limits the real client address instead of the proxy's; GET /api/client-address shows what the
// server sees, to check the setting after deploying.
const trustProxy = Number(process.env.TRUST_PROXY ?? 1);
app.set("trust proxy", Number.isInteger(trustProxy) && trustProxy >= 0 ? trustProxy : 1);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  helmet({
    hsts: process.env.NODE_ENV === "production" ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    // Applies to the web app when this server serves it (WEB_DIST_DIR). It loads only its own files,
    // Google Fonts, and talks to Supabase Storage for lab file uploads.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com", ...(process.env.SUPABASE_URL ? [new URL(process.env.SUPABASE_URL).origin] : [])],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }),
);
app.use("/api", (_req, res, next) => {
  // Responses contain health data; never let browsers or proxies cache them.
  res.setHeader("Cache-Control", "no-store");
  next();
});

// The web app calls the API from its own origin, so cross-origin access is off
// unless origins are listed, e.g. CORS_ALLOWED_ORIGINS="capacitor://localhost,https://localhost".
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : false }));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

app.use("/api", apiLimiter);
app.post("/api/auth/login", loginIpLimiter, loginAccountLimiter);
app.post("/api/auth/register", registrationLimiter);
app.post("/api/auth/password-reset-requests", passwordResetLimiter);
app.get("/api/booklet-verification/:verificationCode", verificationLimiter);

app.use("/api", router);

// The built web app, when this server also serves it (one service on Render): its files, and
// index.html for every other path so the app's own routes work on reload.
const webDir = process.env.WEB_DIST_DIR ? path.resolve(process.env.WEB_DIST_DIR) : null;
if (webDir && existsSync(path.join(webDir, "index.html"))) {
  app.use(express.static(webDir, {
    index: false,
    // File names under /assets carry a content hash, so they can be cached for a year.
    setHeaders: (res, file) => res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache"),
  }));
  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api/") || req.path === "/api") return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(webDir, "index.html"));
  });
} else if (webDir) {
  logger.error({ webDir }, "WEB_DIST_DIR is set but has no index.html; the web app is not served");
}

// Never send stack traces or database details to the client: they can contain personal data.
app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status < 500
    ? error.status
    : 500;
  if (status >= 500) {
    req.log.error({ err: error }, "Unhandled request error");
    // Route pattern (e.g. /doctor/patient/:patientId/records), never ids or query strings.
    const route = `${req.baseUrl}${req.route?.path ?? ""}` || "unknown";
    void recordSecurityEvent({ type: "SERVER_ERROR", severity: "warning", userId: req.currentUser?.id, details: { method: req.method, route }, subject: route, dedupe: true });
  }
  res.status(status).json({ error: status >= 500 ? "Something went wrong. Please try again." : "The request could not be processed." });
});

export default app;
