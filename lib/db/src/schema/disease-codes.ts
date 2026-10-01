import { createInsertSchema } from "drizzle-zod";
import { boolean, index, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const diseaseCodesTable = pgTable(
  "medichain_disease_codes",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    codingSystem: text("coding_system").notNull(),
    release: text("release").notNull(),
    diseaseName: text("disease_name").notNull(),
    description: text("description").notNull().default(""),
    infectious: boolean("infectious").notNull().default(true),
    epidemicRelevant: boolean("epidemic_relevant").notNull().default(false),
    pandemicRelevant: boolean("pandemic_relevant").notNull().default(false),
    status: text("status").notNull().default("ACTIVE"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("medichain_disease_codes_identity_index").on(
      table.codingSystem,
      table.release,
      table.code,
    ),
    index("medichain_disease_codes_name_index").on(table.diseaseName),
    index("medichain_disease_codes_status_index").on(table.status),
  ],
);

export const insertDiseaseCodeSchema = createInsertSchema(diseaseCodesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertDiseaseCode = z.infer<typeof insertDiseaseCodeSchema>;
export type DiseaseCodeRecord = typeof diseaseCodesTable.$inferSelect;