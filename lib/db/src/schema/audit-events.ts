import { createInsertSchema } from "drizzle-zod";
import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
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