import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type MedicalVitals = {
  bloodPressure?: string | null;
  heartRate?: number | null;
  temperature?: number | null;
  weightKg?: number | null;
};

export const usersTable = pgTable(
  "medichain_users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
    name: text("name").notNull(),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    contactInfo: text("contact_info"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("medichain_users_email_unique").on(table.email),
    index("medichain_users_role_index").on(table.role),
  ],
);

export const emergencyInfoTable = pgTable(
  "medichain_emergency_info",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    bloodGroup: text("blood_group").notNull().default("Unknown"),
    weightKg: real("weight_kg").notNull().default(1),
    heightCm: real("height_cm").notNull().default(30),
    allergies: text("allergies").notNull().default(""),
    emergencyContact: text("emergency_contact").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("medichain_emergency_user_unique").on(table.userId)],
);

export const medicalRecordsTable = pgTable(
  "medichain_medical_records",
  {
    id: serial("id").primaryKey(),
    patientId: integer("patient_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    doctorId: integer("doctor_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    recordType: text("record_type").notNull(),
    diagnosis: text("diagnosis").notNull().default(""),
    treatment: text("treatment").notNull().default(""),
    medications: text("medications").array().notNull().default([]),
    notes: text("notes").notNull().default(""),
    vitals: jsonb("vitals")
      .$type<MedicalVitals>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("medichain_records_patient_index").on(table.patientId),
    index("medichain_records_doctor_index").on(table.doctorId),
    index("medichain_records_created_index").on(table.createdAt),
  ],
);

export const accessPermissionsTable = pgTable(
  "medichain_access_permissions",
  {
    id: serial("id").primaryKey(),
    patientId: integer("patient_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    doctorId: integer("doctor_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    granted: boolean("granted").notNull().default(true),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("medichain_permission_patient_doctor_unique").on(
      table.patientId,
      table.doctorId,
    ),
    index("medichain_permission_expiry_index").on(table.expiresAt),
  ],
);

export const patientSearchesTable = pgTable(
  "medichain_patient_searches",
  {
    id: serial("id").primaryKey(),
    patientId: integer("patient_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    doctorId: integer("doctor_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    searchedAt: timestamp("searched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("medichain_search_patient_index").on(table.patientId, table.searchedAt),
  ],
);

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertEmergencyInfoSchema = createInsertSchema(
  emergencyInfoTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMedicalRecordSchema = createInsertSchema(
  medicalRecordsTable,
).omit({ id: true, createdAt: true });
export const insertAccessPermissionSchema = createInsertSchema(
  accessPermissionsTable,
).omit({ id: true, createdAt: true, grantedAt: true });

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type EmergencyInfo = typeof emergencyInfoTable.$inferSelect;
export type MedicalRecord = typeof medicalRecordsTable.$inferSelect;
export type AccessPermission = typeof accessPermissionsTable.$inferSelect;