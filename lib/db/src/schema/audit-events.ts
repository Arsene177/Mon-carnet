import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { usersTable } from "./medichain";

export const auditEventsTable = pgTable(
  "medichain_audit_events",
  {
    id: serial("id").primaryKey(),
    actorUserId: integer("actor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    patientId: integer("patient_id").references(() => usersTable.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id"),
    hospitalName: text("hospital_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("medichain_audit_actor_index").on(table.actorUserId),
    index("medichain_audit_patient_index").on(table.patientId),
    index("medichain_audit_created_index").on(table.createdAt),
  ],
);

export const insertAuditEventSchema = createInsertSchema(auditEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditEvent = z.infer<typeof insertAuditEventSchema>;
export type AuditEventRecord = typeof auditEventsTable.$inferSelect;
/**
 * Security events: suspicious or sensitive activity that administrators should be able to review
 * (locked accounts, sign-in floods, unusual record access, server errors, sensitive admin actions).
 * Kept for 12 months. `details` holds the values the admin screen shows (names, emails, counts);
 * alerts sent outside the app never include them.
 */
export const securityEventsTable = pgTable(
  "medichain_security_events",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    // "info" is only listed; "warning" and "critical" also alert administrators.
    severity: text("severity").notNull(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    ipAddress: text("ip_address"),
    details: jsonb("details").$type<Record<string, string | number | null>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("medichain_security_events_created_index").on(table.createdAt),
    index("medichain_security_events_type_index").on(table.type),
  ],
);
export type SecurityEventRecord = typeof securityEventsTable.$inferSelect;
