import { createInsertSchema } from "drizzle-zod";
import { index, integer, pgTable, serial, text, timestamp, date } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { diseaseCodesTable } from "./disease-codes";
import { medicalRecordsTable } from "./medichain";

export const medicalDiagnosesTable = pgTable(
  "medichain_medical_diagnoses",
  {
    id: serial("id").primaryKey(),
    recordId: integer("record_id")
      .notNull()
      .references(() => medicalRecordsTable.id, { onDelete: "cascade" }),
    diseaseCodeId: integer("disease_code_id")
      .notNull()
      .references(() => diseaseCodesTable.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    diagnosisDate: date("diagnosis_date", { mode: "string" }).notNull(),
    onsetDate: date("onset_date", { mode: "string" }),
    notes: text("notes").notNull().default(""),
    supportingRecordId: integer("supporting_record_id").references(
      () => medicalRecordsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("medichain_medical_diagnoses_record_index").on(table.recordId),
    index("medichain_medical_diagnoses_code_index").on(table.diseaseCodeId),
  ],
);

export const insertMedicalDiagnosisSchema = createInsertSchema(medicalDiagnosesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMedicalDiagnosis = z.infer<typeof insertMedicalDiagnosisSchema>;
export type MedicalDiagnosisRecord = typeof medicalDiagnosesTable.$inferSelect;