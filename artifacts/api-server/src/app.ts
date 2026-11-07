import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  apiLimiter,
  loginAccountLimiter,
  loginIpLimiter,
  passwordResetLimiter,
  registrationLimiter,
  verificationLimiter,
} from "./lib/rate-limits";

const app: Express = express();

// The API runs behind one reverse proxy (Replit or a load balancer). Trusting it
// gives rate limits the real client address instead of the proxy's.
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

// Never send stack traces or database details to the client: they can contain personal data.
app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status < 500
    ? error.status
    : 500;
  if (status >= 500) req.log.error({ err: error }, "Unhandled request error");
  res.status(status).json({ error: status >= 500 ? "Something went wrong. Please try again." : "The request could not be processed." });
});

export default app;
