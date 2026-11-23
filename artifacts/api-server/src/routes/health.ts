import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * The address this server sees for the caller, as rate limits use it. After deploying, it should
 * be your own public address; if it is the host's, adjust TRUST_PROXY (see docs/render.md).
 */
router.get("/client-address", (req, res) => {
  // How many addresses the proxies listed in X-Forwarded-For. When the caller sent none itself, the
  // real client is the first of them, and TRUST_PROXY must equal this number to pick it.
  const forwarded = (req.header("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  res.json({ address: req.ip ?? null, forwardedAddresses: forwarded.length, trustProxy: req.app.get("trust proxy") ?? null });
});

/**
 * Readiness for uptime monitors: answers 200 only when the database responds within 3 seconds,
 * otherwise 503. Reveals nothing beyond "ok" or "unavailable".
 */
router.get("/readyz", async (_req, res) => {
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Database check timed out")), 3000)),
    ]);
    res.json({ status: "ok", database: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable", database: "unavailable" });
  }
});

export default router;
