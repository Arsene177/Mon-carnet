import { createInsertSchema } from "drizzle-zod";
import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { medicalRecordsTable, usersTable } from "./medichain";

export const medicalAttachmentsTable = pgTable(
  "medichain_medical_attachments",
  {
    id: serial("id").primaryKey(),
    patientId: integer("patient_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    doctorId: integer("doctor_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    recordId: integer("record_id").references(() => medicalRecordsTable.id, {
      onDelete: "set null",
    }),
    objectPath: text("object_path").notNull().unique(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    status: text("status").notNull().default("UPLOADING"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
  },
  (table) => [
    index("medichain_attachments_owner_status_index").on(
      table.patientId,
      table.doctorId,
      table.status,
    ),
    index("medichain_attachments_expiry_index").on(table.expiresAt),
    index("medichain_attachments_record_index").on(table.recordId),
  ],
);

export const insertMedicalAttachmentSchema = createInsertSchema(medicalAttachmentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMedicalAttachment = z.infer<typeof insertMedicalAttachmentSchema>;
export type MedicalAttachmentRecord = typeof medicalAttachmentsTable.$inferSelect;
