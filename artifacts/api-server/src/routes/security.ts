// Security events for administrators (see lib/security-events.ts).
import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, securityEventsTable } from "@workspace/db";
import { GetAdminSecurityEventsResponse } from "@workspace/api-zod";
import { requireAuth } from "../lib/medichain-auth";

const router: IRouter = Router();

router.get("/admin/security-events", requireAuth("ADMIN"), async (_req, res): Promise<void> => {
  const events = await db.select().from(securityEventsTable).orderBy(desc(securityEventsTable.createdAt), desc(securityEventsTable.id)).limit(200);
  res.json(GetAdminSecurityEventsResponse.parse(events.map((event) => ({
    id: event.id,
    type: event.type,
    severity: event.severity,
    createdAt: event.createdAt.toISOString(),
    ipAddress: event.ipAddress,
    details: event.details,
  }))));
});

export default router;
