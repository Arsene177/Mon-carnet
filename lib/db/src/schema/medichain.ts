import {
  boolean,
  date,
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  real,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
    // The Supabase Auth user (auth.users.id) that signs in to this account. Null for closed accounts.
    authUserId: uuid("auth_user_id"),
    // Only for accounts copied from the previous database: the old scrypt password hash. The first
    // successful sign-in moves the password to Supabase Auth and clears it. Null for everyone else.
    passwordHash: text("password_hash"),
    role: text("role").notNull(),
    name: text("name").notNull(),
    hospitalName: text("hospital_name"),
    locationRegion: text("location_region"),
    locationArrondissement: text("location_arrondissement"),
    professionalMedicalNumber: text("professional_medical_number"),
    doctorVerified: boolean("doctor_verified").notNull().default(false),
    patientDisplayId: text("patient_display_id"),
    patientAccessId: text("patient_access_id"),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    // True when the patient gave an age instead of an exact date (stored as 1 January of the birth year).
    dateOfBirthEstimated: boolean("date_of_birth_estimated").notNull().default(false),
    // Patients only: "FEMALE" or "MALE"; null until provided.
    sex: text("sex"),
    // Patients only: Cameroon national ID card (CNI) number, upper-case without spaces. Never shown to admins.
    nationalIdNumber: text("national_id_number"),
    contactInfo: text("contact_info"),
    // Patients only. AUTOMATIC: a doctor entering the CM ID gets access until revoked.
    // ASK: the doctor's request waits until the patient approves or rejects it.
    accessApprovalMode: text("access_approval_mode").notNull().default("AUTOMATIC"),
    // "fr" or "en": the language of the app and of notifications sent to this account.
    preferredLanguage: text("preferred_language").notNull().default("fr"),
    isActive: boolean("is_active").notNull().default(true),
    // Set when the account was closed after a deletion request. Closed accounts cannot sign in or be restored.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Two-step sign-in with an authenticator app (TOTP). The factor and its secret are held by
    // Supabase Auth; this records when it was turned on, for display and for the required-role check.
    mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
    // Hash and time of the last authenticator code accepted. Supabase Auth accepts a code more than
    // once within its 30-second window, so the app refuses the same code again for 3 minutes.
    mfaLastCodeHash: text("mfa_last_code_hash"),
    mfaLastCodeAt: timestamp("mfa_last_code_at", { withTimezone: true }),
    // Version of the privacy policy and terms accepted, and when. Patients also record explicit
    // consent to the processing of their health data (sensitive data under Law 2024/017).
    termsVersion: text("terms_version"),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
    healthDataConsentAt: timestamp("health_data_consent_at", { withTimezone: true }),
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
    uniqueIndex("medichain_users_auth_user_id_unique").on(table.authUserId),
    uniqueIndex("medichain_users_patient_display_id_unique").on(table.patientDisplayId),
    uniqueIndex("medichain_users_patient_access_id_unique").on(table.patientAccessId),
    uniqueIndex("medichain_users_national_id_unique").on(table.nationalIdNumber),
    index("medichain_users_role_index").on(table.role),
  ],
).enableRLS();

export const bookletExportsTable = pgTable(
  "medichain_booklet_exports",
  {
    id: serial("id").primaryKey(),
    verificationCode: text("verification_code").notNull().unique(),
    patientId: integer("patient_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    patientDisplayId: text("patient_display_id").notNull(),
    recordCount: integer("record_count").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("medichain_booklet_exports_patient_index").on(table.patientId, table.issuedAt)],
).enableRLS();

export const notificationsTable = pgTable(
  "medichain_notifications",
  {
    id: serial("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    senderId: integer("sender_id").references(() => usersTable.id, { onDelete: "set null" }),
    recipientId: integer("recipient_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    index("medichain_notifications_recipient_created_index").on(table.recipientId, table.createdAt),
    index("medichain_notifications_batch_index").on(table.batchId),
  ],
).enableRLS();

export const passwordResetRequestsTable = pgTable(
  "medichain_password_reset_requests",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: integer("resolved_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("medichain_password_reset_pending_email_unique")
      .on(table.email)
      .where(sql`${table.resolvedAt} is null`),
    index("medichain_password_reset_requested_index").on(table.requestedAt),
  ],
).enableRLS();

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
).enableRLS();

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
    followUpToRecordId: integer("follow_up_to_record_id").references(
      (): AnyPgColumn => medicalRecordsTable.id,
      { onDelete: "set null" },
    ),
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
    index("medichain_records_followup_index").on(table.followUpToRecordId),
    index("medichain_records_created_index").on(table.createdAt),
  ],
).enableRLS();

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
    expiresAt: timestamp("expires_at", { withTimezone: true }),
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
).enableRLS();

export const accountDeletionRequestsTable = pgTable(
  "medichain_account_deletion_requests",
  {
    id: serial("id").primaryKey(),
    // No foreign key: the request is kept as evidence after the account itself is erased.
    userId: integer("user_id").notNull(),
    role: text("role").notNull(),
    reason: text("reason"),
    // PENDING, CANCELLED, REJECTED, COMPLETED
    status: text("status").notNull().default("PENDING"),
    // ERASED (account and medical data deleted) or CLOSED (sign-in and contact details removed, records kept)
    outcome: text("outcome"),
    resolutionNote: text("resolution_note"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: integer("resolved_by").references(() => usersTable.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("medichain_deletion_request_pending_unique")
      .on(table.userId)
      .where(sql`${table.status} = 'PENDING'`),
    index("medichain_deletion_request_status_index").on(table.status, table.requestedAt),
  ],
).enableRLS();

export const accessRequestsTable = pgTable(
  "medichain_access_requests",
  {
    id: serial("id").primaryKey(),
    patientId: integer("patient_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    doctorId: integer("doctor_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    hospitalName: text("hospital_name"),
    // PENDING, APPROVED or REJECTED
    status: text("status").notNull().default("PENDING"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("medichain_access_request_pending_unique")
      .on(table.patientId, table.doctorId)
      .where(sql`${table.status} = 'PENDING'`),
    index("medichain_access_request_patient_index").on(table.patientId, table.requestedAt),
  ],
).enableRLS();

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
    // Emergency reason the doctor declared; null for searches made before reasons were required.
    reason: text("reason"),
    hospitalName: text("hospital_name"),
  },
  (table) => [
    index("medichain_search_patient_index").on(table.patientId, table.searchedAt),
  ],
).enableRLS();

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
/** One-time recovery codes for two-step sign-in, stored as hashes. */
export const mfaRecoveryCodesTable = pgTable(
  "medichain_mfa_recovery_codes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("medichain_mfa_recovery_codes_user_index").on(table.userId)],
).enableRLS();
