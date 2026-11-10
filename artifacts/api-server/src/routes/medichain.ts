import { Router, type IRouter, type Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  ilike,
  lte,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  UpdatePatientIdentityBody,
  UpdatePatientIdentityResponse,
  GetAdminPossibleDuplicatesResponse,
  UpdateLanguageBody,
  UpdateLanguageResponse,
  EmergencyPatientLookupBody,
  EmergencyPatientLookupResponse,
  ApprovePatientAccessRequestBody,
  ApprovePatientAccessRequestParams,
  ApprovePatientAccessRequestResponse,
  GetPatientAccessRequestsResponse,
  GetPatientAccessSettingsResponse,
  RejectPatientAccessRequestParams,
  UpdatePatientAccessSettingsBody,
  UpdatePatientAccessSettingsResponse,
  AddDoctorPatientRecordBody,
  AddDoctorPatientRecordParams,
  AddDoctorPatientRecordResponse,
  ApproveDoctorParams,
  ApproveDoctorResponse,
  CreateBookletVerificationResponse,
  VerifyBookletExportParams,
  VerifyBookletExportResponse,
  ChangePasswordBody,
  ChangePasswordResponse,
  RequestPasswordResetBody,
  RequestPasswordResetResponse,
  GetAdminPasswordResetRequestsResponse,
  ResetAdminRequestedPasswordParams,
  ResetAdminRequestedPasswordResponse,
  GrantPatientPermissionBody,
  GrantPatientPermissionResponse,
  GrantPatientAccessByIdBody,
  GrantPatientAccessByIdResponse,
  GetAdminAnalyticsResponse,
  GetAdminStatsResponse,
  GetDoctorPatientRecordsParams,
  GetDoctorPatientRecordsResponse,
  GetDoctorProfileResponse,
  GetDoctorStatsResponse,
  GetMeResponse,
  GetPatientEmergencyParams,
  GetPatientEmergencyResponse,
  GetPatientPendingRequestsResponse,
  GetPatientPermissionsResponse,
  GetPatientProfileResponse,
  GetPatientRecordsResponse,
  GetPendingDoctorsResponse,
  LoginBody,
  LoginResponse,
  SignOutOtherDevicesResponse,
  RegisterBody,
  RegisterResponse,
  RevokeDoctorParams,
  RevokeDoctorResponse,
  RevokePatientPermissionParams,
  RevokePatientPermissionResponse,
  SearchDiseaseCodesQueryParams,
  SearchDiseaseCodesResponse,
  SearchUsersQueryParams,
  SearchUsersResponse,
  UpdateAdminUserStatusBody,
  UpdateAdminUserStatusParams,
  UpdateAdminUserStatusResponse,
  UpdateAdminEpidemicThresholdBody,
  UpdateAdminEpidemicThresholdParams,
  UpdateAdminEpidemicThresholdResponse,
  GetAdminDirectoryQueryParams,
  GetAdminDirectoryResponse,
  ExportAdminDirectoryQueryParams,
  SendAdminNotificationBody,
  SendAdminNotificationResponse,
  GetNotificationInboxResponse,
  MarkNotificationReadParams,
  MarkNotificationReadResponse,
  UpdateDoctorProfileBody,
  UpdatePatientLocationBody,
  UpdatePatientLocationResponse,
  UpdateEmergencyInfoBody,
  UpdateEmergencyInfoResponse,
  VerifyDoctorParams,
  VerifyDoctorResponse,
} from "@workspace/api-zod";
import { isValidCameroonLocation, LEGAL_DOCUMENTS_VERSION } from "@workspace/api-zod";
import {
  auditEventsTable,
  bookletExportsTable,
  db,
  diseaseCodesTable,
  usersTable,
  emergencyInfoTable,
  medicalDiagnosesTable,
  medicalAttachmentsTable,
  medicalRecordsTable,
  accessPermissionsTable,
  patientSearchesTable,
  notificationsTable,
  accessRequestsTable,
  passwordResetRequestsTable,
} from "@workspace/db";
import { emergencyLookupLimiter } from "../lib/rate-limits";
import { languageOf, notificationMessages } from "../lib/notification-messages";
import {
  createAccessToken,
  endAllSessions,
  hashPassword,
  nextSessionVersion,
  publicUser,
  requireAuth,
  userResponse,
  verifyPassword,
} from "../lib/medichain-auth";
import { verifySecondFactor } from "./mfa";

const router: IRouter = Router();
const patientDisplayIdAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function generatePatientDisplayId() {
  let suffix = "";
  do {
    suffix = Array.from(randomBytes(6), (byte) => patientDisplayIdAlphabet[byte % patientDisplayIdAlphabet.length]).join("");
  } while (!/[0-9]/.test(suffix) || !/[A-Z]/.test(suffix));
  return `CM${suffix}`;
}

async function createUniquePatientDisplayId() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generatePatientDisplayId();
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(or(
        eq(usersTable.patientDisplayId, candidate),
        eq(usersTable.patientAccessId, candidate),
      ))
      .limit(1);
    if (!existing) return candidate;
  }
  throw new Error("Could not create a unique patient display ID.");
}

async function ensurePatientIdentifiers(user: typeof usersTable.$inferSelect) {
  if (user.patientDisplayId && user.patientAccessId === user.patientDisplayId) return user;

  const patientDisplayId = user.patientDisplayId ?? await createUniquePatientDisplayId();
  const [updated] = await db
    .update(usersTable)
    .set({
      patientDisplayId: sql`coalesce(${usersTable.patientDisplayId}, ${patientDisplayId})`,
      patientAccessId: sql`coalesce(${usersTable.patientDisplayId}, ${patientDisplayId})`,
    })
    .where(eq(usersTable.id, user.id))
    .returning();
  if (!updated?.patientDisplayId || !updated.patientAccessId) {
    throw new Error("Patient profile is missing its identifiers.");
  }
  return updated;
}

function privateObjectPathParts(objectPath: string) {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir || !objectPath.startsWith("/objects/uploads/")) {
    throw new Error("Private object storage is not configured.");
  }
  const pathParts = privateDir.replace(/^\/+/, "").split("/");
  const bucketName = pathParts.shift();
  if (!bucketName) throw new Error("Private object storage is not configured.");
  const objectName = [...pathParts, objectPath.slice("/objects/".length)].join("/");
  return { bucketName, objectName };
}

export async function createSignedObjectUrl(objectPath: string, method: "PUT" | "GET" | "DELETE", ttlSeconds: number) {
  const { bucketName, objectName } = privateObjectPathParts(objectPath);
  const response = await fetch("http://127.0.0.1:1106/object-storage/signed-object-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Unable to create a private file URL.");
  const result = await response.json() as { signed_url?: string };
  if (!result.signed_url) throw new Error("Storage did not return a signed URL.");
  return result.signed_url;
}

async function purgeExpiredMedicalAttachments() {
  const expired = await db
    .select({ id: medicalAttachmentsTable.id, objectPath: medicalAttachmentsTable.objectPath })
    .from(medicalAttachmentsTable)
    .where(and(
      inArray(medicalAttachmentsTable.status, ["UPLOADING", "READY"]),
      lt(medicalAttachmentsTable.expiresAt, new Date()),
    ))
    .limit(100);
  for (const attachment of expired) {
    try {
      const deleteURL = await createSignedObjectUrl(attachment.objectPath, "DELETE", 60);
      const response = await fetch(deleteURL, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
      if (response.ok || response.status === 404) {
        await db.delete(medicalAttachmentsTable).where(eq(medicalAttachmentsTable.id, attachment.id));
      } else {
        console.warn("Expired private medical attachment could not be deleted", attachment.id, response.status);
      }
    } catch (error) {
      console.warn("Expired private medical attachment cleanup will be retried", attachment.id, error);
    }
  }
}

export function invalidBody(res: Response, message: string) {
  res.status(400).json({ error: message });
}

type AdminDirectoryKind = "PATIENTS" | "DOCTORS" | "HOSPITALS";

type AdminDirectoryFilters = {
  kind: AdminDirectoryKind;
  region?: string;
  arrondissement?: string;
  uncertified?: boolean;
};

function validDirectoryFilters(filters: AdminDirectoryFilters) {
  if (filters.region !== undefined && !isValidCameroonLocation(filters.region, filters.arrondissement ?? null)) return false;
  if (filters.arrondissement !== undefined && filters.region === undefined) return false;
  return !filters.uncertified || filters.kind === "DOCTORS";
}

async function adminDirectoryEntries(filters: AdminDirectoryFilters, limit: number) {
  const conditions = [];
  if (filters.kind === "PATIENTS") {
    conditions.push(eq(usersTable.role, "PATIENT"));
  } else {
    conditions.push(or(eq(usersTable.role, "DOCTOR"), eq(usersTable.role, "PENDING_DOCTOR"))!);
  }
  if (filters.region) conditions.push(eq(usersTable.locationRegion, filters.region));
  if (filters.arrondissement) conditions.push(eq(usersTable.locationArrondissement, filters.arrondissement));
  if (filters.uncertified) conditions.push(eq(usersTable.doctorVerified, false));
  if (filters.kind === "HOSPITALS") {
    conditions.push(sql`${usersTable.hospitalName} IS NOT NULL AND btrim(${usersTable.hospitalName}) <> ''`);
  }

  const users = await db.select({
    userId: usersTable.id,
    name: usersTable.name,
    locationRegion: usersTable.locationRegion,
    locationArrondissement: usersTable.locationArrondissement,
    hospitalName: usersTable.hospitalName,
    doctorVerified: usersTable.doctorVerified,
  }).from(usersTable).where(and(...conditions)).orderBy(asc(usersTable.name)).limit(limit);

  if (filters.kind === "HOSPITALS") {
    const hospitals = new Map<string, {
      userId: null;
      name: string;
      kind: "HOSPITALS";
      region: string | null;
      arrondissement: string | null;
      hospitalName: string;
      doctorVerified: boolean;
    }>();
    for (const user of users) {
      const hospitalName = user.hospitalName?.trim();
      if (!hospitalName) continue;
      const key = [hospitalName.toLocaleLowerCase(), user.locationRegion ?? "", user.locationArrondissement ?? ""].join("\u0000");
      if (!hospitals.has(key)) {
        hospitals.set(key, {
          userId: null,
          name: hospitalName,
          kind: "HOSPITALS",
          region: user.locationRegion,
          arrondissement: user.locationArrondissement,
          hospitalName,
          doctorVerified: false,
        });
      }
    }
    return [...hospitals.values()].slice(0, limit);
  }

  return users.map((user) => ({
    userId: user.userId,
    name: user.name,
    kind: filters.kind,
    region: user.locationRegion,
    arrondissement: user.locationArrondissement,
    hospitalName: filters.kind === "DOCTORS" ? user.hospitalName : null,
    doctorVerified: filters.kind === "DOCTORS" && user.doctorVerified,
  }));
}

function csvCell(value: string | number | boolean | null) {
  let text = value === null ? "" : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function diseaseCodeResponse(code: typeof diseaseCodesTable.$inferSelect) {
  return {
    id: code.id,
    code: code.code,
    codingSystem: code.codingSystem,
    release: code.release,
    diseaseName: code.diseaseName,
    description: code.description,
    infectious: code.infectious,
    epidemicRelevant: code.epidemicRelevant,
    pandemicRelevant: code.pandemicRelevant,
    status: code.status,
    source: code.source,
  };
}

function codedDiagnosisResponse(row: {
  diagnosis: typeof medicalDiagnosesTable.$inferSelect;
  diseaseCode: typeof diseaseCodesTable.$inferSelect;
}) {
  return {
    id: row.diagnosis.id,
    diseaseCode: diseaseCodeResponse(row.diseaseCode),
    status: row.diagnosis.status,
    diagnosisDate: row.diagnosis.diagnosisDate,
    onsetDate: row.diagnosis.onsetDate,
    notes: row.diagnosis.notes,
    supportingRecordId: row.diagnosis.supportingRecordId,
    createdAt: row.diagnosis.createdAt.toISOString(),
  };
}

async function codedDiagnosesByRecordId(recordIds: number[]) {
  const grouped = new Map<
    number,
    ReturnType<typeof codedDiagnosisResponse>[]
  >();
  if (recordIds.length === 0) return grouped;

  const rows = await db
    .select({ diagnosis: medicalDiagnosesTable, diseaseCode: diseaseCodesTable })
    .from(medicalDiagnosesTable)
    .innerJoin(diseaseCodesTable, eq(medicalDiagnosesTable.diseaseCodeId, diseaseCodesTable.id))
    .where(inArray(medicalDiagnosesTable.recordId, recordIds))
    .orderBy(asc(medicalDiagnosesTable.createdAt), asc(medicalDiagnosesTable.id));

  for (const row of rows) {
    const diagnoses = grouped.get(row.diagnosis.recordId) ?? [];
    diagnoses.push(codedDiagnosisResponse(row));
    grouped.set(row.diagnosis.recordId, diagnoses);
  }
  return grouped;
}

export async function recordsResponse(
  rows: Array<{
    record: typeof medicalRecordsTable.$inferSelect;
    doctorName: string;
  }>,
) {
  const diagnoses = await codedDiagnosesByRecordId(rows.map(({ record }) => record.id));
  return rows.map(({ record, doctorName }) =>
    recordResponse(record, doctorName, diagnoses.get(record.id) ?? []),
  );
}

function recordResponse(
  record: typeof medicalRecordsTable.$inferSelect,
  doctorName: string,
  codedDiagnoses: ReturnType<typeof codedDiagnosisResponse>[] = [],
) {
  return {
    id: record.id,
    patientId: record.patientId,
    doctorId: record.doctorId,
    doctorName,
    recordType: record.recordType,
    diagnosis: record.diagnosis,
    treatment: record.treatment,
    medications: record.medications,
    notes: record.notes,
    followUpToRecordId: record.followUpToRecordId ?? null,
    codedDiagnoses,
    vitals: record.vitals ?? {},
    createdAt: record.createdAt.toISOString(),
  };
}

type PatientIdentity = Pick<typeof usersTable.$inferSelect, "name" | "sex" | "dateOfBirth" | "dateOfBirthEstimated">;

/** True for a Postgres unique-constraint error, also when the ORM wraps it in `cause`. */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    if ("code" in current && (current as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

function sexOf(value: string | null): "FEMALE" | "MALE" | null {
  return value === "FEMALE" || value === "MALE" ? value : null;
}

/** Upper-case CNI number without spaces, dots or dashes; null when empty. */
function normalizeNationalId(value: string | null | undefined): string | null {
  const normalized = (value ?? "").replace(/[\s.\-/]/g, "").toUpperCase();
  return normalized || null;
}

function isPlausibleBirthDate(value: Date): boolean {
  const year = value.getUTCFullYear();
  return value.getTime() <= Date.now() && year >= new Date().getUTCFullYear() - 130;
}

export function emergencyResponse(
  info: typeof emergencyInfoTable.$inferSelect,
  patient: PatientIdentity,
) {
  return {
    patientId: info.userId,
    patientName: patient.name,
    patientSex: sexOf(patient.sex),
    patientDateOfBirth: patient.dateOfBirth ?? null,
    patientDateOfBirthEstimated: patient.dateOfBirthEstimated,
    bloodGroup: info.bloodGroup,
    weightKg: info.weightKg,
    heightCm: info.heightCm,
    allergies: info.allergies,
    emergencyContact: info.emergencyContact,
    updatedAt: info.updatedAt.toISOString(),
  };
}

const ACCESS_REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const REJECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const accessRequestCutoff = () => new Date(Date.now() - ACCESS_REQUEST_LIFETIME_MS);

async function getActivePermission(patientId: number, doctorId: number) {
  const [permission] = await db
    .select()
    .from(accessPermissionsTable)
    .where(
      and(
        eq(accessPermissionsTable.patientId, patientId),
        eq(accessPermissionsTable.doctorId, doctorId),
        eq(accessPermissionsTable.granted, true),
        or(isNull(accessPermissionsTable.expiresAt), gte(accessPermissionsTable.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return permission;
}

async function permissionResponse(
  permission: typeof accessPermissionsTable.$inferSelect,
) {
  const [doctor] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, permission.doctorId))
    .limit(1);
  return GrantPatientPermissionResponse.parse({
    id: permission.id,
    doctorId: permission.doctorId,
    doctorName: doctor?.name ?? "Doctor",
    doctorEmail: doctor?.email ?? "",
    doctorVerified: doctor?.doctorVerified ?? false,
    granted: permission.granted,
    grantedAt: permission.grantedAt.toISOString(),
    expiresAt: permission.expiresAt?.toISOString() ?? null,
  });
}

router.post("/auth/register", async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Please check the registration details and try again.");
    return;
  }
  const input = parsed.data;
  if (!input.name.trim()) {
    invalidBody(res, "Name is required.");
    return;
  }
  const professionalMedicalNumber = input.professionalMedicalNumber?.trim() || null;
  if (!input.contactInfo?.trim() || (input.role === "PATIENT" && !input.dateOfBirth)) {
    invalidBody(
      res,
      input.role === "PATIENT"
        ? "Patient registration requires a date of birth and contact information."
        : "Doctor registration requires contact information.",
    );
    return;
  }
  if (input.role === "PATIENT" && (!input.sex || !input.dateOfBirth || !isPlausibleBirthDate(input.dateOfBirth))) {
    invalidBody(res, "Patient registration requires sex and a valid date of birth or age.");
    return;
  }
  if (input.acceptedTermsVersion !== LEGAL_DOCUMENTS_VERSION || (input.role === "PATIENT" && input.healthDataConsent !== true)) {
    invalidBody(res, "Accept the terms of use and privacy policy to create an account. Patients must also consent to the processing of their health data.");
    return;
  }
  const nationalIdNumber = input.role === "PATIENT" ? normalizeNationalId(input.nationalIdNumber) : null;
  if (nationalIdNumber && !/^[A-Z0-9]{5,20}$/.test(nationalIdNumber)) {
    invalidBody(res, "Enter the ID card number as it appears on the card (letters and digits only).");
    return;
  }
  if (input.role === "DOCTOR" && !professionalMedicalNumber) {
    invalidBody(res, "Doctor registration requires a professional medical number.");
    return;
  }

  try {
    const patientDisplayId = input.role === "PATIENT" ? await createUniquePatientDisplayId() : null;
    const [created] = await db
      .insert(usersTable)
      .values({
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        passwordHash: hashPassword(input.password),
        role: input.role === "DOCTOR" ? "PENDING_DOCTOR" : "PATIENT",
        professionalMedicalNumber: input.role === "DOCTOR" ? professionalMedicalNumber : null,
        patientDisplayId,
        patientAccessId: patientDisplayId,
        dateOfBirth:
          input.role === "PATIENT" && input.dateOfBirth
            ? input.dateOfBirth.toISOString().slice(0, 10)
            : null,
        contactInfo: input.contactInfo?.trim() || null,
        preferredLanguage: input.preferredLanguage ?? "fr",
        termsVersion: LEGAL_DOCUMENTS_VERSION,
        termsAcceptedAt: new Date(),
        healthDataConsentAt: input.role === "PATIENT" ? new Date() : null,
        sex: input.role === "PATIENT" ? input.sex : null,
        dateOfBirthEstimated: input.role === "PATIENT" ? Boolean(input.dateOfBirthEstimated) : false,
        nationalIdNumber,
      })
      .returning();
    const user = publicUser(created);
    res.status(201).json(
      RegisterResponse.parse({
        token: createAccessToken(user, created.sessionVersion),
        user: userResponse(created),
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Unable to create an account with those details." });
      return;
    }
    throw error;
  }
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user || !user.isActive || !verifyPassword(parsed.data.password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  if (user.mfaEnabledAt) {
    const code = parsed.data.code?.trim();
    if (!code) {
      // The password was right; ask for the code from the authenticator app.
      res.json(LoginResponse.parse({ mfaRequired: true }));
      return;
    }
    if (!(await verifySecondFactor(user, code))) {
      res.status(401).json({ error: "The code is incorrect or expired.", mfaRequired: true });
      return;
    }
  }
  const current = publicUser(user);
  res.json(
    LoginResponse.parse({
      mfaRequired: false,
      token: createAccessToken(current, user.sessionVersion),
      user: userResponse(user),
    }),
  );
});

router.post("/auth/password-reset-requests", async (req, res): Promise<void> => {
  const parsed = RequestPasswordResetBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter a valid email address.");
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (user) {
    await db
      .insert(passwordResetRequestsTable)
      .values({ email })
      .onConflictDoNothing({
        target: [passwordResetRequestsTable.email],
        where: isNull(passwordResetRequestsTable.resolvedAt),
      });
  }

  res.status(202).json(
    RequestPasswordResetResponse.parse({
      message: "If an account exists for that email, an administrator will review your request.",
    }),
  );
});

router.put("/auth/language", requireAuth(), async (req, res): Promise<void> => {
  const parsed = UpdateLanguageBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Choose French or English.");
    return;
  }
  const [user] = await db
    .update(usersTable)
    .set({ preferredLanguage: parsed.data.language })
    .where(eq(usersTable.id, req.currentUser!.id))
    .returning();
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.json(UpdateLanguageResponse.parse(userResponse(user)));
});

router.get("/auth/me", requireAuth(), async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.currentUser!.id)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.json(GetMeResponse.parse(userResponse(user)));
});

router.post("/auth/change-password", requireAuth(), async (req, res): Promise<void> => {
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter your current password and a new password of at least 8 characters.");
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.currentUser!.id)).limit(1);
  if (!user || !verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
    res.status(400).json({ error: "Current password is incorrect." });
    return;
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    invalidBody(res, "Choose a new password that differs from your current password.");
    return;
  }
  // A new password ends every session, so anyone signed in with the old one is signed out.
  // This device stays signed in with the fresh token returned here.
  const [updated] = await db
    .update(usersTable)
    .set({ passwordHash: hashPassword(parsed.data.newPassword), sessionVersion: nextSessionVersion() })
    .where(eq(usersTable.id, user.id))
    .returning();
  await db.insert(auditEventsTable).values({
    actorUserId: user.id,
    action: "PASSWORD_CHANGED",
    entityType: "account",
    entityId: user.id,
  });
  res.json(ChangePasswordResponse.parse({ token: createAccessToken(publicUser(updated!), updated!.sessionVersion) }));
});

router.post("/auth/sign-out-other-devices", requireAuth(), async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const sessionVersion = await endAllSessions(userId);
  if (sessionVersion === undefined) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  await db.insert(auditEventsTable).values({
    actorUserId: userId,
    action: "OTHER_SESSIONS_SIGNED_OUT",
    entityType: "account",
    entityId: userId,
  });
  res.json(SignOutOtherDevicesResponse.parse({ token: createAccessToken(req.currentUser!, sessionVersion) }));
});

router.get("/patient/profile", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  const profileUser = await ensurePatientIdentifiers(user);
  const [emergency] = await db
    .select()
    .from(emergencyInfoTable)
    .where(eq(emergencyInfoTable.userId, userId))
    .limit(1);
  const [records] = await db
    .select({ value: count() })
    .from(medicalRecordsTable)
    .where(eq(medicalRecordsTable.patientId, userId));
  const [permissions] = await db
    .select({ value: count() })
    .from(accessPermissionsTable)
    .where(
      and(
        eq(accessPermissionsTable.patientId, userId),
        eq(accessPermissionsTable.granted, true),
        or(isNull(accessPermissionsTable.expiresAt), gte(accessPermissionsTable.expiresAt, new Date())),
      ),
    );
  res.json(
    GetPatientProfileResponse.parse({
      user: userResponse(user),
      patientDisplayId: profileUser.patientDisplayId,
      patientAccessId: profileUser.patientAccessId,
      emergencyInfo: emergency ? emergencyResponse(emergency, user) : null,
      recordCount: records.value,
      permissionsCount: permissions.value,
      nationalIdNumber: user.nationalIdNumber,
    }),
  );
});

router.put("/patient/profile", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const parsed = UpdatePatientLocationBody.safeParse(req.body);
  if (!parsed.success || !isValidCameroonLocation(parsed.data?.locationRegion, parsed.data?.locationArrondissement)) {
    invalidBody(res, "Choose a valid Cameroon region and arrondissement.");
    return;
  }
  const [updated] = await db.update(usersTable)
    .set({
      locationRegion: parsed.data.locationRegion,
      locationArrondissement: parsed.data.locationArrondissement,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, req.currentUser!.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Profile not found." });
    return;
  }
  res.json(UpdatePatientLocationResponse.parse(userResponse(updated)));
});

router.put("/patient/identity", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const parsed = UpdatePatientIdentityBody.safeParse(req.body);
  if (!parsed.success || !isPlausibleBirthDate(parsed.data.dateOfBirth)) {
    invalidBody(res, "Choose your sex and enter a valid date of birth or age.");
    return;
  }
  const nationalIdNumber = normalizeNationalId(parsed.data.nationalIdNumber);
  if (nationalIdNumber && !/^[A-Z0-9]{5,20}$/.test(nationalIdNumber)) {
    invalidBody(res, "Enter the ID card number as it appears on the card (letters and digits only).");
    return;
  }
  const dateOfBirth = parsed.data.dateOfBirthEstimated
    ? `${parsed.data.dateOfBirth.getUTCFullYear()}-01-01`
    : parsed.data.dateOfBirth.toISOString().slice(0, 10);
  try {
    const [updated] = await db
      .update(usersTable)
      .set({ sex: parsed.data.sex, dateOfBirth, dateOfBirthEstimated: parsed.data.dateOfBirthEstimated, nationalIdNumber })
      .where(eq(usersTable.id, req.currentUser!.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Profile not found." });
      return;
    }
    res.json(UpdatePatientIdentityResponse.parse(userResponse(updated)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "This ID card number is already registered to another account. Contact support if this is your card." });
      return;
    }
    throw error;
  }
});

router.put("/patient/emergency-info", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const parsed = UpdateEmergencyInfoBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Emergency information is invalid. Check the values and try again.");
    return;
  }
  const { bloodGroup, weightKg, heightCm, allergies, emergencyContact } = parsed.data;
  const userId = req.currentUser!.id;
  const [saved] = await db
    .insert(emergencyInfoTable)
    .values({ userId, bloodGroup, weightKg, heightCm, allergies, emergencyContact })
    .onConflictDoUpdate({
      target: emergencyInfoTable.userId,
      set: {
        bloodGroup,
        weightKg,
        heightCm,
        allergies,
        emergencyContact,
        updatedAt: new Date(),
      },
    })
    .returning();
  const [user] = await db
    .select({ name: usersTable.name, sex: usersTable.sex, dateOfBirth: usersTable.dateOfBirth, dateOfBirthEstimated: usersTable.dateOfBirthEstimated })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  res.json(
    UpdateEmergencyInfoResponse.parse(
      emergencyResponse(saved, user ?? { name: "Patient", sex: null, dateOfBirth: null, dateOfBirthEstimated: false }),
    ),
  );
});

router.get("/patient/records", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const rows = await db
    .select({ record: medicalRecordsTable, doctorName: usersTable.name })
    .from(medicalRecordsTable)
    .innerJoin(usersTable, eq(medicalRecordsTable.doctorId, usersTable.id))
    .where(eq(medicalRecordsTable.patientId, req.currentUser!.id))
    .orderBy(desc(medicalRecordsTable.createdAt));
  await db.insert(auditEventsTable).values({
    actorUserId: req.currentUser!.id,
    patientId: req.currentUser!.id,
    action: "MEDICAL_RECORDS_VIEWED",
    entityType: "medical_record_collection",
  });
  res.json(
    GetPatientRecordsResponse.parse(
      await recordsResponse(rows),
    ),
  );
});

router.post("/patient/booklet-verification", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const patientId = req.currentUser!.id;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, patientId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "Patient profile not found." });
    return;
  }
  const profile = await ensurePatientIdentifiers(user);
  if (!profile.patientDisplayId) {
    throw new Error("Patient profile is missing its CM ID.");
  }
  const [records] = await db
    .select({ value: count() })
    .from(medicalRecordsTable)
    .where(eq(medicalRecordsTable.patientId, patientId));
  const [bookletExport] = await db
    .insert(bookletExportsTable)
    .values({
      verificationCode: randomUUID(),
      patientId,
      patientDisplayId: profile.patientDisplayId,
      recordCount: records.value,
    })
    .returning();
  if (!bookletExport) {
    throw new Error("Booklet verification reference was not created.");
  }
  await db.insert(auditEventsTable).values({
    actorUserId: patientId,
    patientId,
    action: "PATIENT_BOOKLET_EXPORTED",
    entityType: "booklet_export",
    entityId: bookletExport.id,
  });
  res.json(CreateBookletVerificationResponse.parse({
    verificationCode: bookletExport.verificationCode,
    patientDisplayId: bookletExport.patientDisplayId,
    recordCount: bookletExport.recordCount,
    issuedAt: bookletExport.issuedAt.toISOString(),
  }));
});

router.get("/booklet-verification/:verificationCode", async (req, res): Promise<void> => {
  const parsed = VerifyBookletExportParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "Booklet verification reference not found." });
    return;
  }
  const [bookletExport] = await db
    .select({
      recordCount: bookletExportsTable.recordCount,
      issuedAt: bookletExportsTable.issuedAt,
    })
    .from(bookletExportsTable)
    .where(eq(bookletExportsTable.verificationCode, parsed.data.verificationCode))
    .limit(1);
  if (!bookletExport) {
    res.status(404).json({ error: "Booklet verification reference not found." });
    return;
  }
  res.json(VerifyBookletExportResponse.parse({
    valid: true,
    recordCount: bookletExport.recordCount,
    issuedAt: bookletExport.issuedAt.toISOString(),
  }));
});

router.get("/patient/permissions", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(accessPermissionsTable)
    .where(eq(accessPermissionsTable.patientId, req.currentUser!.id))
    .orderBy(desc(accessPermissionsTable.grantedAt));
  const response = await Promise.all(rows.map(permissionResponse));
  res.json(GetPatientPermissionsResponse.parse(response));
});

router.post("/patient/permissions", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const parsed = GrantPatientPermissionBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Choose a registered doctor and an access duration between 1 and 365 days.");
    return;
  }
  const email = parsed.data.doctorEmail.trim().toLowerCase();
  const [doctor] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.email, email), eq(usersTable.role, "DOCTOR"), eq(usersTable.isActive, true)))
    .limit(1);
  if (!doctor) {
    res.status(404).json({ error: "Approved doctor not found" });
    return;
  }
  const grantedAt = new Date();
  const expiresAt = new Date(grantedAt.getTime() + parsed.data.durationDays * 24 * 60 * 60 * 1000);
  const [permission] = await db
    .insert(accessPermissionsTable)
    .values({
      patientId: req.currentUser!.id,
      doctorId: doctor.id,
      granted: true,
      grantedAt,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [accessPermissionsTable.patientId, accessPermissionsTable.doctorId],
      set: { granted: true, grantedAt, expiresAt },
    })
    .returning();
  res.status(201).json(await permissionResponse(permission));
});

router.delete(
  "/patient/permissions/:doctorId",
  requireAuth("PATIENT"),
  async (req, res): Promise<void> => {
    const parsed = RevokePatientPermissionParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid doctor" });
      return;
    }
    await db.transaction(async (tx) => {
      const revoked = await tx
        .update(accessPermissionsTable)
        .set({ granted: false, expiresAt: new Date() })
        .where(
          and(
            eq(accessPermissionsTable.patientId, req.currentUser!.id),
            eq(accessPermissionsTable.doctorId, parsed.data.doctorId),
          ),
        )
        .returning({ id: accessPermissionsTable.id });
      if (revoked.length > 0) {
        const patientDisplayId = await createUniquePatientDisplayId();
        await tx
          .update(usersTable)
          .set({ patientDisplayId, patientAccessId: patientDisplayId })
          .where(eq(usersTable.id, req.currentUser!.id));
      }
    });
    res.status(204).send();
  },
);

router.get("/patient/pending-requests", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const rows = await db
    .select({ search: patientSearchesTable, doctor: usersTable })
    .from(patientSearchesTable)
    .innerJoin(usersTable, eq(patientSearchesTable.doctorId, usersTable.id))
    .where(eq(patientSearchesTable.patientId, req.currentUser!.id))
    .orderBy(desc(patientSearchesTable.searchedAt))
    .limit(50);
  const seen = new Set<number>();
  const response = [];
  for (const row of rows) {
    if (seen.has(row.search.doctorId)) continue;
    seen.add(row.search.doctorId);
    const active = await getActivePermission(req.currentUser!.id, row.search.doctorId);
    if (!active) {
      response.push({
        doctorId: row.doctor.id,
        doctorName: row.doctor.name,
        doctorEmail: row.doctor.email,
        doctorVerified: row.doctor.doctorVerified,
        searchedAt: row.search.searchedAt.toISOString(),
        reason: row.search.reason,
        hospitalName: row.search.hospitalName,
      });
    }
  }
  res.json(GetPatientPendingRequestsResponse.parse(response));
});

router.get("/patient/access-settings", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const [user] = await db
    .select({ accessApprovalMode: usersTable.accessApprovalMode })
    .from(usersTable)
    .where(eq(usersTable.id, req.currentUser!.id))
    .limit(1);
  res.json(GetPatientAccessSettingsResponse.parse({ accessApprovalMode: user?.accessApprovalMode ?? "AUTOMATIC" }));
});

router.put("/patient/access-settings", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const parsed = UpdatePatientAccessSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Choose automatic access or ask me first.");
    return;
  }
  const patientId = req.currentUser!.id;
  await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({ accessApprovalMode: parsed.data.accessApprovalMode })
      .where(eq(usersTable.id, patientId));
    await tx.insert(auditEventsTable).values({
      actorUserId: patientId,
      patientId,
      action: `ACCESS_APPROVAL_MODE_${parsed.data.accessApprovalMode}`,
      entityType: "access_settings",
    });
  });
  res.json(UpdatePatientAccessSettingsResponse.parse({ accessApprovalMode: parsed.data.accessApprovalMode }));
});

router.get("/patient/access-requests", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const rows = await db
    .select({ request: accessRequestsTable, doctor: usersTable })
    .from(accessRequestsTable)
    .innerJoin(usersTable, eq(accessRequestsTable.doctorId, usersTable.id))
    .where(and(
      eq(accessRequestsTable.patientId, req.currentUser!.id),
      eq(accessRequestsTable.status, "PENDING"),
      gte(accessRequestsTable.requestedAt, accessRequestCutoff()),
      eq(usersTable.isActive, true),
    ))
    .orderBy(desc(accessRequestsTable.requestedAt));
  res.json(GetPatientAccessRequestsResponse.parse(rows.map(({ request, doctor }) => ({
    id: request.id,
    doctorId: doctor.id,
    doctorName: doctor.name,
    doctorEmail: doctor.email,
    doctorVerified: doctor.doctorVerified,
    hospitalName: request.hospitalName,
    requestedAt: request.requestedAt.toISOString(),
    expiresAt: new Date(request.requestedAt.getTime() + ACCESS_REQUEST_LIFETIME_MS).toISOString(),
  }))));
});

export async function recipientLanguage(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: number,
) {
  const [user] = await tx
    .select({ preferredLanguage: usersTable.preferredLanguage })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return languageOf(user?.preferredLanguage);
}

async function resolvePendingAccessRequest(
  patientId: number,
  requestId: number,
  status: "APPROVED" | "REJECTED",
  onResolved: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    request: typeof accessRequestsTable.$inferSelect,
  ) => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .update(accessRequestsTable)
      .set({ status, resolvedAt: new Date() })
      .where(and(
        eq(accessRequestsTable.id, requestId),
        eq(accessRequestsTable.patientId, patientId),
        eq(accessRequestsTable.status, "PENDING"),
        gte(accessRequestsTable.requestedAt, accessRequestCutoff()),
      ))
      .returning();
    if (!request) return false;
    await onResolved(tx, request);
    return true;
  });
}

router.post("/patient/access-requests/:requestId/approve", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const params = ApprovePatientAccessRequestParams.safeParse(req.params);
  const body = ApprovePatientAccessRequestBody.safeParse(req.body);
  if (!params.success || !body.success) {
    invalidBody(res, "Choose how long the doctor can access your booklet.");
    return;
  }
  const patient = req.currentUser!;
  let permission: typeof accessPermissionsTable.$inferSelect | undefined;
  const resolved = await resolvePendingAccessRequest(patient.id, params.data.requestId, "APPROVED", async (tx, request) => {
    const grantedAt = new Date();
    const expiresAt = body.data.durationDays === null
      ? null
      : new Date(grantedAt.getTime() + body.data.durationDays * 24 * 60 * 60 * 1000);
    [permission] = await tx
      .insert(accessPermissionsTable)
      .values({ patientId: patient.id, doctorId: request.doctorId, granted: true, grantedAt, expiresAt })
      .onConflictDoUpdate({
        target: [accessPermissionsTable.patientId, accessPermissionsTable.doctorId],
        set: { granted: true, grantedAt, expiresAt },
      })
      .returning();
    await tx.insert(auditEventsTable).values({
      actorUserId: patient.id,
      patientId: patient.id,
      action: "PATIENT_ACCESS_REQUEST_APPROVED",
      entityType: "access_request",
      entityId: request.id,
    });
    await tx.insert(notificationsTable).values({
      batchId: randomUUID(),
      senderId: patient.id,
      recipientId: request.doctorId,
      ...notificationMessages.accessApproved(
        await recipientLanguage(tx, request.doctorId),
        patient.name,
        expiresAt ? expiresAt.toISOString().slice(0, 10) : null,
      ),
    });
  });
  if (!resolved || !permission) {
    res.status(404).json({ error: "This request is no longer waiting for a decision." });
    return;
  }
  res.json(ApprovePatientAccessRequestResponse.parse(await permissionResponse(permission)));
});

router.post("/patient/access-requests/:requestId/reject", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const params = RejectPatientAccessRequestParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const patient = req.currentUser!;
  const resolved = await resolvePendingAccessRequest(patient.id, params.data.requestId, "REJECTED", async (tx, request) => {
    await tx.insert(auditEventsTable).values({
      actorUserId: patient.id,
      patientId: patient.id,
      action: "PATIENT_ACCESS_REQUEST_REJECTED",
      entityType: "access_request",
      entityId: request.id,
    });
    await tx.insert(notificationsTable).values({
      batchId: randomUUID(),
      senderId: patient.id,
      recipientId: request.doctorId,
      ...notificationMessages.accessRejected(await recipientLanguage(tx, request.doctorId), patient.name),
    });
  });
  if (!resolved) {
    res.status(404).json({ error: "This request is no longer waiting for a decision." });
    return;
  }
  res.status(204).send();
});

router.get("/patient/access-history", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const patientId = req.currentUser!.id;
  const rows = await db
    .select({
      id: auditEventsTable.id,
      doctorName: usersTable.name,
      hospitalName: auditEventsTable.hospitalName,
      action: auditEventsTable.action,
      accessedAt: auditEventsTable.createdAt,
    })
    .from(auditEventsTable)
    .innerJoin(usersTable, eq(auditEventsTable.actorUserId, usersTable.id))
    .where(and(
      eq(auditEventsTable.patientId, patientId),
      ne(auditEventsTable.actorUserId, patientId),
      inArray(auditEventsTable.action, [
        "MEDICAL_RECORDS_VIEWED",
        "EMERGENCY_INFO_VIEWED",
        "MEDICAL_ATTACHMENT_DOWNLOADED",
      ]),
    ))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(100);
  res.json(rows.map((row) => ({
    id: row.id,
    doctorName: row.doctorName,
    hospitalName: row.hospitalName || "Hospital not provided",
    action: row.action.replaceAll("_", " ").toLowerCase(),
    accessedAt: row.accessedAt.toISOString(),
  })));
});

router.get("/doctor/profile", requireAuth("DOCTOR"), async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.currentUser!.id)).limit(1);
  if (!user) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json(GetDoctorProfileResponse.parse(userResponse(user)));
});

router.put("/doctor/profile", requireAuth("DOCTOR"), async (req, res): Promise<void> => {
  const parsed = UpdateDoctorProfileBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter valid professional details and a valid Cameroon location.");
    return;
  }
  const [current] = await db.select({
    locationRegion: usersTable.locationRegion,
    locationArrondissement: usersTable.locationArrondissement,
  }).from(usersTable).where(eq(usersTable.id, req.currentUser!.id)).limit(1);
  if (!current) {
    res.status(404).json({ error: "Doctor profile not found." });
    return;
  }
  const locationRegion = parsed.data.locationRegion === undefined ? current.locationRegion : parsed.data.locationRegion;
  const locationArrondissement = parsed.data.locationArrondissement === undefined ? current.locationArrondissement : parsed.data.locationArrondissement;
  if (!isValidCameroonLocation(locationRegion, locationArrondissement)) {
    invalidBody(res, "Enter valid professional details and a valid Cameroon location.");
    return;
  }
  const hospitalName = parsed.data.hospitalName.trim();
  const professionalMedicalNumber = parsed.data.professionalMedicalNumber.trim();
  const numberChanged = professionalMedicalNumber !== (req.currentUser!.professionalMedicalNumber ?? "");
  const [updated] = await db.update(usersTable)
    .set({
      hospitalName: hospitalName || null,
      professionalMedicalNumber: professionalMedicalNumber || null,
      locationRegion,
      locationArrondissement,
      ...(numberChanged ? { doctorVerified: false } : {}),
    })
    .where(eq(usersTable.id, req.currentUser!.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Doctor profile not found." });
    return;
  }
  res.json(userResponse(updated));
});

const ACCENTED = "ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖòóôõöÙÚÛÜùúûüÇçÑñ";
const UNACCENTED = "AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn";
const MAX_EMERGENCY_LOOKUP_MATCHES = 3;

/** Lower-case name words without accents, sorted so that word order does not matter. */
function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort();
}

router.post(
  "/doctor/emergency-lookup",
  requireAuth("DOCTOR"),
  emergencyLookupLimiter,
  async (req, res): Promise<void> => {
    const parsed = EmergencyPatientLookupBody.safeParse(req.body);
    if (!parsed.success) {
      invalidBody(res, "Enter the patient's full name and the reason you need their emergency information (at least 10 characters).");
      return;
    }
    const tokens = nameTokens(parsed.data.fullName);
    const reason = parsed.data.reason.trim();
    if (tokens.length < 2 || reason.length < 10) {
      invalidBody(res, "Enter the patient's full name (at least two names) and the reason you need their emergency information.");
      return;
    }
    const dateOfBirth = parsed.data.dateOfBirth ? parsed.data.dateOfBirth.toISOString().slice(0, 10) : null;
    const searchableName = sql`lower(translate(${usersTable.name}, ${ACCENTED}, ${UNACCENTED}))`;
    const candidates = await db
      .select()
      .from(usersTable)
      .where(and(
        eq(usersTable.role, "PATIENT"),
        eq(usersTable.isActive, true),
        ...(dateOfBirth ? [eq(usersTable.dateOfBirth, dateOfBirth)] : []),
        ...tokens.map((token) => sql`${searchableName} like ${`%${token}%`}`),
      ))
      .limit(200);
    const wanted = tokens.join(" ");
    const matches = candidates.filter((patient) => nameTokens(patient.name).join(" ") === wanted);
    if (matches.length > MAX_EMERGENCY_LOOKUP_MATCHES) {
      res.status(422).json({
        error: `More than ${MAX_EMERGENCY_LOOKUP_MATCHES} patients have this name. Add the patient's date of birth to narrow the lookup.`,
      });
      return;
    }

    const doctor = req.currentUser!;
    const results = [];
    for (const patient of matches) {
      const [emergency] = await db
        .select()
        .from(emergencyInfoTable)
        .where(eq(emergencyInfoTable.userId, patient.id))
        .limit(1);
      await db.transaction(async (tx) => {
        await tx.insert(patientSearchesTable).values({
          patientId: patient.id,
          doctorId: doctor.id,
          reason,
          hospitalName: doctor.hospitalName,
        });
        if (!emergency) return;
        await tx.insert(auditEventsTable).values({
          actorUserId: doctor.id,
          patientId: patient.id,
          action: "EMERGENCY_INFO_VIEWED",
          entityType: "emergency_info",
          hospitalName: doctor.hospitalName,
        });
        await tx.insert(notificationsTable).values({
          batchId: randomUUID(),
          senderId: doctor.id,
          recipientId: patient.id,
          ...notificationMessages.emergencyLookup(languageOf(patient.preferredLanguage), doctor.name, doctor.hospitalName, reason),
        });
      });
      if (emergency) results.push({ emergencyInfo: emergencyResponse(emergency, patient) });
    }
    res.json(EmergencyPatientLookupResponse.parse(results));
  },
);

router.post("/doctor/patient-access", requireAuth("DOCTOR"), async (req, res): Promise<void> => {
  const parsed = GrantPatientAccessByIdBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter a valid patient CM ID.");
    return;
  }
  const attemptsSince = new Date(Date.now() - 15 * 60_000);
  const [recentFailedAttempts] = await db
    .select({ value: count() })
    .from(auditEventsTable)
    .where(and(
      eq(auditEventsTable.actorUserId, req.currentUser!.id),
      eq(auditEventsTable.action, "PATIENT_ACCESS_CODE_REJECTED"),
      gte(auditEventsTable.createdAt, attemptsSince),
    ));
  if (recentFailedAttempts.value >= 5) {
    res.status(429).json({ error: "Too many incorrect CM IDs. Try again in 15 minutes." });
    return;
  }
  const [matchedPatient] = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.patientDisplayId, parsed.data.patientDisplayId.toUpperCase()),
        eq(usersTable.role, "PATIENT"),
        eq(usersTable.isActive, true),
      ),
    )
    .limit(1);
  if (!matchedPatient) {
    await db.insert(auditEventsTable).values({
      actorUserId: req.currentUser!.id,
      action: "PATIENT_ACCESS_CODE_REJECTED",
      entityType: "patient_access_code",
      hospitalName: req.currentUser!.hospitalName,
    });
    res.status(404).json({ error: "Patient CM ID not found." });
    return;
  }
  const patient = await ensurePatientIdentifiers(matchedPatient);
  const doctor = req.currentUser!;
  const accessResponse = (status: "GRANTED" | "PENDING") =>
    GrantPatientAccessByIdResponse.parse({
      status,
      patientId: patient.id,
      patientDisplayId: patient.patientDisplayId,
      patientName: patient.name,
      patientSex: sexOf(patient.sex),
      patientDateOfBirth: patient.dateOfBirth ?? null,
      patientDateOfBirthEstimated: patient.dateOfBirthEstimated,
      patientNationalIdNumber: status === "GRANTED" ? patient.nationalIdNumber : null,
    });

  if (patient.accessApprovalMode === "ASK") {
    if (await getActivePermission(patient.id, doctor.id)) {
      res.json(accessResponse("GRANTED"));
      return;
    }
    const [recentRejection] = await db
      .select({ id: accessRequestsTable.id })
      .from(accessRequestsTable)
      .where(and(
        eq(accessRequestsTable.patientId, patient.id),
        eq(accessRequestsTable.doctorId, doctor.id),
        eq(accessRequestsTable.status, "REJECTED"),
        gte(accessRequestsTable.resolvedAt, new Date(Date.now() - REJECTION_COOLDOWN_MS)),
      ))
      .limit(1);
    if (recentRejection) {
      res.status(429).json({
        error: "This patient declined your request recently. Speak with the patient before asking again tomorrow.",
      });
      return;
    }
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(accessRequestsTable)
        .set({ status: "EXPIRED", resolvedAt: now })
        .where(and(
          eq(accessRequestsTable.patientId, patient.id),
          eq(accessRequestsTable.doctorId, doctor.id),
          eq(accessRequestsTable.status, "PENDING"),
          lt(accessRequestsTable.requestedAt, accessRequestCutoff()),
        ));
      const [existing] = await tx
        .update(accessRequestsTable)
        .set({ requestedAt: now, hospitalName: doctor.hospitalName })
        .where(and(
          eq(accessRequestsTable.patientId, patient.id),
          eq(accessRequestsTable.doctorId, doctor.id),
          eq(accessRequestsTable.status, "PENDING"),
        ))
        .returning({ id: accessRequestsTable.id });
      const request = existing ?? (await tx
        .insert(accessRequestsTable)
        .values({ patientId: patient.id, doctorId: doctor.id, hospitalName: doctor.hospitalName, requestedAt: now })
        .returning({ id: accessRequestsTable.id }))[0];
      if (!existing) {
        await tx.insert(notificationsTable).values({
          batchId: randomUUID(),
          senderId: doctor.id,
          recipientId: patient.id,
          ...notificationMessages.accessRequested(languageOf(patient.preferredLanguage), doctor.name, doctor.hospitalName),
        });
      }
      await tx.insert(auditEventsTable).values({
        actorUserId: doctor.id,
        patientId: patient.id,
        action: "PATIENT_ACCESS_REQUESTED",
        entityType: "access_request",
        entityId: request?.id,
        hospitalName: doctor.hospitalName,
      });
    });
    res.json(accessResponse("PENDING"));
    return;
  }

  const grantedAt = new Date();
  await db.transaction(async (tx) => {
    const [permission] = await tx
      .insert(accessPermissionsTable)
      .values({
        patientId: patient.id,
        doctorId: req.currentUser!.id,
        granted: true,
        grantedAt,
        expiresAt: null,
      })
      .onConflictDoUpdate({
        target: [accessPermissionsTable.patientId, accessPermissionsTable.doctorId],
        set: { granted: true, grantedAt, expiresAt: null },
      })
      .returning();
    if (!permission) {
      throw new Error("Patient access grant returned no row.");
    }

    await tx.insert(auditEventsTable).values({
      actorUserId: req.currentUser!.id,
      patientId: patient.id,
      action: "PATIENT_ACCESS_ID_USED",
      entityType: "access_permission",
      entityId: permission.id,
      hospitalName: req.currentUser!.hospitalName,
    });
  });

  res.json(accessResponse("GRANTED"));
});

router.get(
  "/disease-codes",
  requireAuth("PATIENT", "PENDING_DOCTOR", "DOCTOR", "ADMIN"),
  async (req, res): Promise<void> => {
    const parsed = SearchDiseaseCodesQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter at least two characters to search." });
      return;
    }
    const pattern = `%${parsed.data.query.trim()}%`;
    const rows = await db
      .select()
      .from(diseaseCodesTable)
      .where(
        and(
          eq(diseaseCodesTable.status, "ACTIVE"),
          or(
            ilike(diseaseCodesTable.code, pattern),
            ilike(diseaseCodesTable.diseaseName, pattern),
            ilike(diseaseCodesTable.description, pattern),
            ilike(diseaseCodesTable.codingSystem, pattern),
            ilike(diseaseCodesTable.release, pattern),
          ),
        ),
      )
      .orderBy(asc(diseaseCodesTable.diseaseName), asc(diseaseCodesTable.code))
      .limit(50);
    res.json(SearchDiseaseCodesResponse.parse(rows.map(diseaseCodeResponse)));
  },
);

router.post(
  "/doctor/patient/:patientId/attachments/upload-url",
  requireAuth("DOCTOR"),
  async (req, res): Promise<void> => {
    const patientId = Number(req.params.patientId);
    const { fileName, contentType, size } = req.body ?? {};
    const safeName = typeof fileName === "string" ? fileName.trim() : "";
    if (
      !Number.isInteger(patientId) || patientId < 1 ||
      !safeName || safeName.length > 255 ||
      !["application/pdf", "image/png", "image/jpeg"].includes(contentType) ||
      !Number.isInteger(size) || size < 1 || size > 10 * 1024 * 1024
    ) {
      invalidBody(res, "Upload a PDF, PNG, or JPEG file up to 10 MB.");
      return;
    }
    if (!(await getActivePermission(patientId, req.currentUser!.id))) {
      res.status(403).json({ error: "Patient access is not currently granted or has expired." });
      return;
    }
    await purgeExpiredMedicalAttachments();
    const objectPath = `/objects/uploads/${randomUUID()}`;
    try {
      const [attachment] = await db.insert(medicalAttachmentsTable).values({
        patientId,
        doctorId: req.currentUser!.id,
        objectPath,
        fileName: safeName,
        contentType,
        size,
        status: "UPLOADING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }).returning();
      if (!attachment) throw new Error("Medical attachment reservation returned no row.");
      const uploadURL = await createSignedObjectUrl(objectPath, "PUT", 900);
      res.status(201).json({
        attachmentId: attachment.id,
        uploadURL,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        size: attachment.size,
      });
    } catch (error) {
      req.log.error({ err: error }, "Unable to create private medical document upload URL");
      res.status(503).json({ error: "Private file storage is temporarily unavailable." });
    }
  },
);

router.get(
  "/doctor/patient/:patientId/attachments/pending",
  requireAuth("DOCTOR"),
  async (req, res): Promise<void> => {
    const patientId = Number(req.params.patientId);
    if (!Number.isInteger(patientId) || patientId < 1) {
      res.status(400).json({ error: "Invalid patient ID." });
      return;
    }
    if (!(await getActivePermission(patientId, req.currentUser!.id))) {
      res.status(403).json({ error: "Patient access is not currently granted or has expired." });
      return;
    }
    await purgeExpiredMedicalAttachments();
    const rows = await db.select({
      id: medicalAttachmentsTable.id,
      fileName: medicalAttachmentsTable.fileName,
      contentType: medicalAttachmentsTable.contentType,
      size: medicalAttachmentsTable.size,
      status: medicalAttachmentsTable.status,
      expiresAt: medicalAttachmentsTable.expiresAt,
    }).from(medicalAttachmentsTable).where(and(
      eq(medicalAttachmentsTable.patientId, patientId),
      eq(medicalAttachmentsTable.doctorId, req.currentUser!.id),
      inArray(medicalAttachmentsTable.status, ["UPLOADING", "READY"]),
      gt(medicalAttachmentsTable.expiresAt, new Date()),
    )).orderBy(asc(medicalAttachmentsTable.createdAt));
    res.json(rows.map((row) => ({
      ...row,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    })));
  },
);

router.post(
  "/doctor/patient/:patientId/attachments/:attachmentId/complete",
  requireAuth("DOCTOR"),
  async (req, res): Promise<void> => {
    const patientId = Number(req.params.patientId);
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isInteger(patientId) || patientId < 1 || !Number.isInteger(attachmentId) || attachmentId < 1) {
      res.status(400).json({ error: "Invalid attachment reference." });
      return;
    }
    if (!(await getActivePermission(patientId, req.currentUser!.id))) {
      res.status(403).json({ error: "Patient access is not currently granted or has expired." });
      return;
    }
    const [attachment] = await db.select().from(medicalAttachmentsTable).where(and(
      eq(medicalAttachmentsTable.id, attachmentId),
      eq(medicalAttachmentsTable.patientId, patientId),
      eq(medicalAttachmentsTable.doctorId, req.currentUser!.id),
      inArray(medicalAttachmentsTable.status, ["UPLOADING", "READY"]),
      gt(medicalAttachmentsTable.expiresAt, new Date()),
    )).limit(1);
    if (!attachment) {
      res.status(404).json({ error: "This pending upload was not found or has expired." });
      return;
    }
    if (attachment.status === "READY") {
      res.json({ id: attachment.id, status: attachment.status });
      return;
    }
    try {
      const probeURL = await createSignedObjectUrl(attachment.objectPath, "GET", 60);
      const probe = await fetch(probeURL, {
        headers: { Range: "bytes=0-0" },
        signal: AbortSignal.timeout(30_000),
      });
      await probe.body?.cancel();
      if (!probe.ok) {
        res.status(409).json({ error: "The file is not available in private storage yet. Retry the upload." });
        return;
      }
      const [updated] = await db.update(medicalAttachmentsTable).set({
        status: "READY",
        uploadedAt: new Date(),
      }).where(and(
        eq(medicalAttachmentsTable.id, attachmentId),
        eq(medicalAttachmentsTable.status, "UPLOADING"),
        gt(medicalAttachmentsTable.expiresAt, new Date()),
      )).returning({ id: medicalAttachmentsTable.id, status: medicalAttachmentsTable.status });
      if (!updated) {
        res.status(409).json({ error: "This upload is no longer pending." });
        return;
      }
      res.json(updated);
    } catch (error) {
      req.log.error({ err: error }, "Unable to confirm private medical document upload");
      res.status(503).json({ error: "Private file storage is temporarily unavailable." });
    }
  },
);

router.delete(
  "/doctor/patient/:patientId/attachments/:attachmentId",
  requireAuth("DOCTOR"),
  async (req, res): Promise<void> => {
    const patientId = Number(req.params.patientId);
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isInteger(patientId) || patientId < 1 || !Number.isInteger(attachmentId) || attachmentId < 1) {
      res.status(400).json({ error: "Invalid attachment reference." });
      return;
    }
    if (!(await getActivePermission(patientId, req.currentUser!.id))) {
      res.status(403).json({ error: "Patient access is not currently granted or has expired." });
      return;
    }
    const [attachment] = await db.select().from(medicalAttachmentsTable).where(and(
      eq(medicalAttachmentsTable.id, attachmentId),
      eq(medicalAttachmentsTable.patientId, patientId),
      eq(medicalAttachmentsTable.doctorId, req.currentUser!.id),
      inArray(medicalAttachmentsTable.status, ["UPLOADING", "READY"]),
    )).limit(1);
    if (!attachment) {
      res.status(404).json({ error: "This pending attachment was not found." });
      return;
    }
    try {
      const deleteURL = await createSignedObjectUrl(attachment.objectPath, "DELETE", 60);
      const deleted = await fetch(deleteURL, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
      if (!deleted.ok && deleted.status !== 404) {
        res.status(503).json({ error: "The file could not be removed from private storage." });
        return;
      }
      await db.delete(medicalAttachmentsTable).where(eq(medicalAttachmentsTable.id, attachment.id));
      res.status(204).end();
    } catch (error) {
      req.log.error({ err: error }, "Unable to delete pending private medical document");
      res.status(503).json({ error: "Private file storage is temporarily unavailable." });
    }
  },
);

router.get(
  "/attachments/download-url",
  requireAuth("PATIENT", "DOCTOR"),
  async (req, res): Promise<void> => {
    const patientId = Number(req.query.patientId);
    const objectPath = typeof req.query.objectPath === "string" ? req.query.objectPath : "";
    if (!Number.isInteger(patientId) || patientId < 1 || !/^\/objects\/uploads\/[0-9a-f-]{36}$/.test(objectPath)) {
      res.status(400).json({ error: "Invalid document reference." });
      return;
    }
    const current = req.currentUser!;
    if (current.role === "PATIENT" && current.id !== patientId) {
      res.status(403).json({ error: "You cannot access this medical document." });
      return;
    }
    if (current.role === "DOCTOR" && !(await getActivePermission(patientId, current.id))) {
      res.status(403).json({ error: "Patient access is not currently granted or has expired." });
      return;
    }
    const [record] = await db.select({ id: medicalRecordsTable.id })
      .from(medicalRecordsTable)
      .where(and(
        eq(medicalRecordsTable.patientId, patientId),
        ilike(medicalRecordsTable.notes, `%${objectPath}%`),
      ))
      .limit(1);
    if (!record) {
      res.status(404).json({ error: "Document was not found in this patient's record." });
      return;
    }
    try {
      const downloadURL = await createSignedObjectUrl(objectPath, "GET", 300);
      if (current.role === "DOCTOR") {
        await db.insert(auditEventsTable).values({
          actorUserId: current.id,
          patientId,
          action: "MEDICAL_ATTACHMENT_DOWNLOADED",
          entityType: "medical_attachment",
          entityId: record.id,
          hospitalName: current.hospitalName,
        });
      }
      res.json({ downloadURL });
    } catch (error) {
      req.log.error({ err: error }, "Unable to create private medical document download URL");
      res.status(503).json({ error: "Private file storage is temporarily unavailable." });
    }
  },
);

router.get(
  "/doctor/patient/:patientId/emergency",
  requireAuth("DOCTOR"),
  async (req, res): Promise<void> => {
    const parsed = GetPatientEmergencyParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid patient" });
      return;
    }
    const [patient] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.id, parsed.data.patientId), eq(usersTable.role, "PATIENT")))
      .limit(1);
    if (!patient) {
      res.status(404).json({ error: "Patient not found" });
      return;
    }
    const [info] = await db
      .select()
      .from(emergencyInfoTable)
      .where(eq(emergencyInfoTable.userId, patient.id))
      .limit(1);
    if (!info) {
      res.status(404).json({ error: "Emergency information has not been added" });
      return;
    }
    await db.insert(auditEventsTable).values({
      actorUserId: req.currentUser!.id,
      patientId: patient.id,
      action: "EMERGENCY_INFO_VIEWED",
      entityType: "emergency_info",
      hospitalName: req.currentUser!.hospitalName,
    });
    res.json(GetPatientEmergencyResponse.parse(emergencyResponse(info, patient)));
  },
);

router.get(
  "/doctor/patient/:patientId/records",
  requireAuth("DOCTOR"),
  async (req, res): Promise<void> => {
    const parsed = GetDoctorPatientRecordsParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid patient" });
      return;
    }
    const patientId = parsed.data.patientId;
    const [patient] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.id, patientId), eq(usersTable.role, "PATIENT")))
      .limit(1);
    if (!patient) {
      res.status(404).json({ error: "Patient not found" });
      return;
    }
    if (!(await getActivePermission(patientId, req.currentUser!.id))) {
      res.status(403).json({ error: "Patient access is not currently granted or has expired." });
      return;
    }
    const rows = await db
      .select({ record: medicalRecordsTable, doctorName: usersTable.name })
      .from(medicalRecordsTable)
      .innerJoin(usersTable, eq(medicalRecordsTable.doctorId, usersTable.id))
      .where(eq(medicalRecordsTable.patientId, patientId))
      .orderBy(desc(medicalRecordsTable.createdAt));
    await db.insert(auditEventsTable).values({
      actorUserId: req.currentUser!.id,
      patientId,
      action: "MEDICAL_RECORDS_VIEWED",
      entityType: "medical_record_collection",
      hospitalName: req.currentUser!.hospitalName,
    });
    res.json(
      GetDoctorPatientRecordsResponse.parse(
        await recordsResponse(rows),
      ),
    );
  },
);

router.post(
  "/doctor/patient/:patientId/records",
  requireAuth("DOCTOR"),
  async (req, res): Promise<void> => {
    const params = AddDoctorPatientRecordParams.safeParse(req.params);
    const body = AddDoctorPatientRecordBody.safeParse(req.body);
    if (!params.success || !body.success) {
      invalidBody(res, "Please check the medical record details and vital sign ranges.");
      return;
    }
    const patientId = params.data.patientId;
    const followUpToRecordId = body.data.followUpToRecordId;
    const codedDiagnoses = body.data.codedDiagnoses ?? [];
    const attachmentIds = body.data.attachmentIds ?? [];
    const isFollowUp = body.data.recordType === "Follow-up";
    if (
      new Set(attachmentIds).size !== attachmentIds.length ||
      attachmentIds.length > 5 ||
      (attachmentIds.length > 0 && body.data.recordType !== "Lab Results")
    ) {
      invalidBody(res, "Attach up to five unique pending documents to a lab-results record.");
      return;
    }
    if (isFollowUp !== (followUpToRecordId !== null)) {
      invalidBody(
        res,
        "Follow-up records must link to an existing record for this patient.",
      );
      return;
    }
    const [patient] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.id, patientId), eq(usersTable.role, "PATIENT")))
      .limit(1);
    if (!patient) {
      res.status(404).json({ error: "Patient not found" });
      return;
    }
    if (!(await getActivePermission(patientId, req.currentUser!.id))) {
      res.status(403).json({ error: "Patient access is not currently granted or has expired." });
      return;
    }
    const readyAttachments = attachmentIds.length
      ? await db.select({
          id: medicalAttachmentsTable.id,
          objectPath: medicalAttachmentsTable.objectPath,
          fileName: medicalAttachmentsTable.fileName,
        }).from(medicalAttachmentsTable).where(and(
          eq(medicalAttachmentsTable.patientId, patientId),
          eq(medicalAttachmentsTable.doctorId, req.currentUser!.id),
          eq(medicalAttachmentsTable.status, "READY"),
          gt(medicalAttachmentsTable.expiresAt, new Date()),
          inArray(medicalAttachmentsTable.id, attachmentIds),
        ))
      : [];
    if (readyAttachments.length !== attachmentIds.length) {
      res.status(409).json({ error: "One or more lab reports are no longer available. Refresh pending uploads and retry." });
      return;
    }
    const attachmentNotes = readyAttachments.map(
      (attachment) => `Attachment: ${attachment.fileName}\nAttachment object: ${attachment.objectPath}`,
    );
    const recordNotes = [
      body.data.notes.trim(),
      ...attachmentNotes,
    ].filter(Boolean).join("\n\n");
    const diseaseCodeIds = codedDiagnoses.map((diagnosis) => diagnosis.diseaseCodeId);
    if (new Set(diseaseCodeIds).size !== diseaseCodeIds.length) {
      invalidBody(res, "A disease code can only be attached once to a record.");
      return;
    }
    if (diseaseCodeIds.length > 0) {
      const activeCodes = await db
        .select({ id: diseaseCodesTable.id })
        .from(diseaseCodesTable)
        .where(
          and(
            inArray(diseaseCodesTable.id, diseaseCodeIds),
            eq(diseaseCodesTable.status, "ACTIVE"),
          ),
        );
      if (activeCodes.length !== diseaseCodeIds.length) {
        invalidBody(res, "One or more selected disease codes are unavailable.");
        return;
      }
    }
    const supportingRecordIds = [
      ...new Set(
        codedDiagnoses.flatMap((diagnosis) =>
          diagnosis.supportingRecordId === null ? [] : [diagnosis.supportingRecordId],
        ),
      ),
    ];
    if (supportingRecordIds.length > 0) {
      const supportingRecords = await db
        .select({ id: medicalRecordsTable.id })
        .from(medicalRecordsTable)
        .where(
          and(
            eq(medicalRecordsTable.patientId, patientId),
            inArray(medicalRecordsTable.id, supportingRecordIds),
          ),
        );
      if (supportingRecords.length !== supportingRecordIds.length) {
        invalidBody(res, "Supporting records must belong to this patient.");
        return;
      }
    }
    if (followUpToRecordId !== null) {
      const [parentRecord] = await db
        .select({ id: medicalRecordsTable.id })
        .from(medicalRecordsTable)
        .where(
          and(
            eq(medicalRecordsTable.id, followUpToRecordId),
            eq(medicalRecordsTable.patientId, patientId),
          ),
        )
        .limit(1);
      if (!parentRecord) {
        res.status(404).json({ error: "The record to follow up on was not found for this patient." });
        return;
      }
    }
    let record: typeof medicalRecordsTable.$inferSelect;
    try {
      record = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(medicalRecordsTable)
        .values({
          patientId,
          doctorId: req.currentUser!.id,
          recordType: body.data.recordType,
          diagnosis: body.data.diagnosis,
          treatment: body.data.treatment,
          medications: body.data.medications,
          notes: recordNotes,
          followUpToRecordId,
          vitals: body.data.vitals,
        })
        .returning();
      if (!created) throw new Error("Medical record insert returned no row");

      if (attachmentIds.length > 0) {
        const linkedAttachments = await tx.update(medicalAttachmentsTable).set({
          recordId: created.id,
          status: "ATTACHED",
          expiresAt: null,
          attachedAt: new Date(),
        }).where(and(
          inArray(medicalAttachmentsTable.id, attachmentIds),
          eq(medicalAttachmentsTable.patientId, patientId),
          eq(medicalAttachmentsTable.doctorId, req.currentUser!.id),
          eq(medicalAttachmentsTable.status, "READY"),
          gt(medicalAttachmentsTable.expiresAt, new Date()),
        )).returning({ id: medicalAttachmentsTable.id });
        if (linkedAttachments.length !== attachmentIds.length) {
          throw new Error("PENDING_ATTACHMENTS_CHANGED");
        }
      }

      const diagnoses =
        codedDiagnoses.length > 0
          ? await tx
              .insert(medicalDiagnosesTable)
              .values(
                codedDiagnoses.map((diagnosis) => ({
                  recordId: created.id,
                  diseaseCodeId: diagnosis.diseaseCodeId,
                  status: diagnosis.status,
                  diagnosisDate: diagnosis.diagnosisDate.toISOString().slice(0, 10),
                  onsetDate:
                    diagnosis.onsetDate?.toISOString().slice(0, 10) ?? null,
                  notes: diagnosis.notes,
                  supportingRecordId: diagnosis.supportingRecordId,
                })),
              )
              .returning()
          : [];

      await tx.insert(auditEventsTable).values([
        {
          actorUserId: req.currentUser!.id,
          patientId,
          action: "MEDICAL_RECORD_CREATED",
          entityType: "medical_record",
          entityId: created.id,
        },
        ...diagnoses.map((diagnosis) => ({
          actorUserId: req.currentUser!.id,
          patientId,
          action: "CODED_DIAGNOSIS_CREATED",
          entityType: "coded_diagnosis",
          entityId: diagnosis.id,
        })),
      ]);
      return created;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "PENDING_ATTACHMENTS_CHANGED") {
        res.status(409).json({ error: "One or more lab reports were changed before saving. Refresh pending uploads and retry." });
        return;
      }
      throw error;
    }
    const diagnosesByRecord = await codedDiagnosesByRecordId([record.id]);
    res.status(201).json(
      AddDoctorPatientRecordResponse.parse(
        recordResponse(
          record,
          req.currentUser!.name,
          diagnosesByRecord.get(record.id) ?? [],
        ),
      ),
    );
  },
);

router.get("/doctor/stats", requireAuth("DOCTOR"), async (req, res): Promise<void> => {
  const doctorId = req.currentUser!.id;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [patients] = await db
    .select({ value: countDistinct(medicalRecordsTable.patientId) })
    .from(medicalRecordsTable)
    .where(eq(medicalRecordsTable.doctorId, doctorId));
  const [records] = await db
    .select({ value: count() })
    .from(medicalRecordsTable)
    .where(eq(medicalRecordsTable.doctorId, doctorId));
  const [monthly] = await db
    .select({ value: count() })
    .from(medicalRecordsTable)
    .where(and(eq(medicalRecordsTable.doctorId, doctorId), gte(medicalRecordsTable.createdAt, monthStart)));
  res.json(
    GetDoctorStatsResponse.parse({
      patientsTreated: patients.value,
      recordsAdded: records.value,
      recordsThisMonth: monthly.value,
    }),
  );
});

router.get("/admin/stats", requireAuth("ADMIN"), async (_req, res): Promise<void> => {
  const [patients] = await db
    .select({ value: count() })
    .from(usersTable)
    .where(eq(usersTable.role, "PATIENT"));
  const [doctors] = await db
    .select({ value: count() })
    .from(usersTable)
    .where(and(eq(usersTable.role, "DOCTOR"), eq(usersTable.isActive, true)));
  const [pending] = await db
    .select({ value: count() })
    .from(usersTable)
    .where(eq(usersTable.role, "PENDING_DOCTOR"));
  const [records] = await db.select({ value: count() }).from(medicalRecordsTable);
  const [permissions] = await db
    .select({ value: count() })
    .from(accessPermissionsTable)
    .where(
      and(
        eq(accessPermissionsTable.granted, true),
        or(isNull(accessPermissionsTable.expiresAt), gte(accessPermissionsTable.expiresAt, new Date())),
      ),
    );
  res.json(
    GetAdminStatsResponse.parse({
      totalPatients: patients.value,
      activeDoctors: doctors.value,
      pendingDoctors: pending.value,
      totalConsultations: records.value,
      activePermissions: permissions.value,
    }),
  );
});

router.get("/admin/analytics", requireAuth("ADMIN"), async (_req, res): Promise<void> => {
  const [patients] = await db.select({ value: count() }).from(usersTable).where(eq(usersTable.role, "PATIENT"));
  const [doctors] = await db
    .select({ value: count() })
    .from(usersTable)
    .where(and(eq(usersTable.role, "DOCTOR"), eq(usersTable.isActive, true)));
  const [pending] = await db.select({ value: count() }).from(usersTable).where(eq(usersTable.role, "PENDING_DOCTOR"));
  const [records] = await db.select({ value: count() }).from(medicalRecordsTable);
  const [permissions] = await db
    .select({ value: count() })
    .from(accessPermissionsTable)
    .where(and(
      eq(accessPermissionsTable.granted, true),
      or(isNull(accessPermissionsTable.expiresAt), gte(accessPermissionsTable.expiresAt, new Date())),
    ));
  const since = new Date();
  since.setMonth(since.getMonth() - 5, 1);
  since.setHours(0, 0, 0, 0);
  const monthlyRows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${medicalRecordsTable.createdAt}), 'Mon YYYY')`,
      count: count(),
      monthKey: sql<string>`to_char(date_trunc('month', ${medicalRecordsTable.createdAt}), 'YYYY-MM')`,
    })
    .from(medicalRecordsTable)
    .where(gte(medicalRecordsTable.createdAt, since))
    .groupBy(sql`date_trunc('month', ${medicalRecordsTable.createdAt})`)
    .orderBy(sql`date_trunc('month', ${medicalRecordsTable.createdAt})`);
  const byMonth = new Map(monthlyRows.map((row) => [row.monthKey, row]));
  const monthlyRecords = Array.from({ length: 6 }, (_, index) => {
    const month = new Date(since.getFullYear(), since.getMonth() + index, 1);
    const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
    return {
      month: month.toLocaleDateString("en", { month: "short" }),
      count: byMonth.get(key)?.count ?? 0,
    };
  });
  const recordsByType = await db
    .select({
      recordType: medicalRecordsTable.recordType,
      count: count(),
    })
    .from(medicalRecordsTable)
    .groupBy(medicalRecordsTable.recordType)
    .orderBy(desc(count()), asc(medicalRecordsTable.recordType));
  const regionalActivity = await db
    .select({
      region: usersTable.locationRegion,
      patientCount: countDistinct(medicalRecordsTable.patientId),
      recordCount: count(),
    })
    .from(medicalRecordsTable)
    .innerJoin(usersTable, eq(medicalRecordsTable.patientId, usersTable.id))
    .where(sql`${usersTable.locationRegion} IS NOT NULL`)
    .groupBy(usersTable.locationRegion)
    .having(sql`count(distinct ${medicalRecordsTable.patientId}) >= 5`)
    .orderBy(desc(countDistinct(medicalRecordsTable.patientId)), asc(usersTable.locationRegion));
  const clinicActivity = await db
    .select({
      hospitalName: usersTable.hospitalName,
      region: usersTable.locationRegion,
      patientCount: countDistinct(medicalRecordsTable.patientId),
      recordCount: count(),
    })
    .from(medicalRecordsTable)
    .innerJoin(usersTable, eq(medicalRecordsTable.doctorId, usersTable.id))
    .where(sql`${usersTable.hospitalName} IS NOT NULL AND btrim(${usersTable.hospitalName}) <> ''`)
    .groupBy(usersTable.hospitalName, usersTable.locationRegion)
    .having(sql`count(distinct ${medicalRecordsTable.patientId}) >= 5`)
    .orderBy(desc(countDistinct(medicalRecordsTable.patientId)), asc(usersTable.hospitalName));
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const dateOffset = (days: number) =>
    new Date(todayUtc.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const previousWindowStart = dateOffset(-13);
  const currentWindowStart = dateOffset(-6);
  const currentWindowEnd = dateOffset(0);
  const caseDate = sql`coalesce(${medicalDiagnosesTable.onsetDate}, ${medicalDiagnosesTable.diagnosisDate})`;
  const epidemicRows = await db
    .select({
      diseaseCodeId: diseaseCodesTable.id,
      diseaseName: diseaseCodesTable.diseaseName,
      code: diseaseCodesTable.code,
      codingSystem: diseaseCodesTable.codingSystem,
      threshold: diseaseCodesTable.epidemicAlertThreshold,
      last7Cases: countDistinct(sql`case when ${caseDate} >= ${currentWindowStart} then ${medicalRecordsTable.patientId} end`),
      previous7Cases: countDistinct(sql`case when ${caseDate} < ${currentWindowStart} then ${medicalRecordsTable.patientId} end`),
    })
    .from(medicalDiagnosesTable)
    .innerJoin(medicalRecordsTable, eq(medicalDiagnosesTable.recordId, medicalRecordsTable.id))
    .innerJoin(diseaseCodesTable, eq(medicalDiagnosesTable.diseaseCodeId, diseaseCodesTable.id))
    .where(and(
      eq(diseaseCodesTable.epidemicRelevant, true),
      eq(diseaseCodesTable.status, "ACTIVE"),
      inArray(medicalDiagnosesTable.status, ["suspected", "probable", "confirmed"]),
      gte(caseDate, previousWindowStart),
      lte(caseDate, currentWindowEnd),
    ))
    .groupBy(
      diseaseCodesTable.id,
      diseaseCodesTable.diseaseName,
      diseaseCodesTable.code,
      diseaseCodesTable.codingSystem,
      diseaseCodesTable.epidemicAlertThreshold,
    );
  const casesByDisease = new Map(epidemicRows.map((row) => [row.diseaseCodeId, row]));
  const epidemicCodes = await db
    .select({
      diseaseCodeId: diseaseCodesTable.id,
      diseaseName: diseaseCodesTable.diseaseName,
      code: diseaseCodesTable.code,
      codingSystem: diseaseCodesTable.codingSystem,
      threshold: diseaseCodesTable.epidemicAlertThreshold,
    })
    .from(diseaseCodesTable)
    .where(and(eq(diseaseCodesTable.epidemicRelevant, true), eq(diseaseCodesTable.status, "ACTIVE")))
    .orderBy(asc(diseaseCodesTable.diseaseName));
  const epidemicMetrics = epidemicCodes.map((code) => {
    const cases = casesByDisease.get(code.diseaseCodeId);
    const last7Cases = cases?.last7Cases ?? 0;
    const threshold = code.threshold;
    const alertLevel = last7Cases >= threshold
      ? "ALERT"
      : last7Cases >= Math.max(1, Math.ceil(threshold * 0.8))
        ? "WATCH"
        : "NORMAL";
    return {
      diseaseCodeId: code.diseaseCodeId,
      diseaseName: code.diseaseName,
      code: code.code,
      codingSystem: code.codingSystem,
      last7Cases,
      previous7Cases: cases?.previous7Cases ?? 0,
      threshold,
      alertLevel,
    };
  });
  res.json(
    GetAdminAnalyticsResponse.parse({
      stats: {
        totalPatients: patients.value,
        activeDoctors: doctors.value,
        pendingDoctors: pending.value,
        totalConsultations: records.value,
        activePermissions: permissions.value,
      },
      monthlyRecords,
      recordsByType,
      regionalActivity,
      clinicActivity,
      systemStatus: [
        { name: "API services", status: "Operational" },
        { name: "Database", status: "Operational" },
        { name: "Access controls", status: "Operational" },
      ],
      epidemicMetrics,
    }),
  );
});

router.put("/admin/disease-codes/:diseaseCodeId/epidemic-threshold", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const parsedParams = UpdateAdminEpidemicThresholdParams.safeParse(req.params);
  const parsedBody = UpdateAdminEpidemicThresholdBody.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    invalidBody(res, "Enter a whole-number alert threshold between 1 and 10,000 cases.");
    return;
  }
  const [updated] = await db
    .update(diseaseCodesTable)
    .set({ epidemicAlertThreshold: parsedBody.data.threshold })
    .where(and(
      eq(diseaseCodesTable.id, parsedParams.data.diseaseCodeId),
      eq(diseaseCodesTable.epidemicRelevant, true),
    ))
    .returning({ diseaseCodeId: diseaseCodesTable.id, threshold: diseaseCodesTable.epidemicAlertThreshold });
  if (!updated) {
    res.status(404).json({ error: "Epidemic-relevant disease not found." });
    return;
  }
  res.json(UpdateAdminEpidemicThresholdResponse.parse(updated));
});

router.get("/admin/pending-doctors", requireAuth("ADMIN"), async (_req, res): Promise<void> => {
  const pending = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.role, "PENDING_DOCTOR"))
    .orderBy(desc(usersTable.createdAt));
  res.json(GetPendingDoctorsResponse.parse(pending.map(userResponse)));
});

router.post("/admin/doctors/:doctorId/approve", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const parsed = ApproveDoctorParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid doctor" });
    return;
  }
  const [doctor] = await db
    .update(usersTable)
    .set({ role: "DOCTOR", updatedAt: new Date() })
    .where(and(eq(usersTable.id, parsed.data.doctorId), eq(usersTable.role, "PENDING_DOCTOR"), eq(usersTable.isActive, true)))
    .returning();
  if (!doctor) {
    res.status(404).json({ error: "Pending doctor not found" });
    return;
  }
  res.json(ApproveDoctorResponse.parse(userResponse(doctor)));
});

router.post("/admin/doctors/:doctorId/revoke", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const parsed = RevokeDoctorParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid doctor" });
    return;
  }
  const [doctor] = await db
    .update(usersTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(usersTable.id, parsed.data.doctorId),
        or(eq(usersTable.role, "DOCTOR"), eq(usersTable.role, "PENDING_DOCTOR")),
      ),
    )
    .returning();
  if (!doctor) {
    res.status(404).json({ error: "Doctor not found" });
    return;
  }
  res.json(RevokeDoctorResponse.parse(userResponse(doctor)));
});

router.post("/admin/doctors/:doctorId/verify", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const parsed = VerifyDoctorParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid doctor" });
    return;
  }
  const [doctor] = await db
    .update(usersTable)
    .set({ doctorVerified: true, updatedAt: new Date() })
    .where(and(
      eq(usersTable.id, parsed.data.doctorId),
      or(eq(usersTable.role, "DOCTOR"), eq(usersTable.role, "PENDING_DOCTOR")),
      sql`${usersTable.professionalMedicalNumber} IS NOT NULL`,
      ne(usersTable.professionalMedicalNumber, ""),
    ))
    .returning();
  if (!doctor) {
    res.status(400).json({ error: "Doctor must submit a professional medical number before verification." });
    return;
  }
  res.json(VerifyDoctorResponse.parse(userResponse(doctor)));
});

router.put("/admin/users/:userId/status", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const parsedParams = UpdateAdminUserStatusParams.safeParse(req.params);
  const parsedBody = UpdateAdminUserStatusBody.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    invalidBody(res, "Choose a valid account status.");
    return;
  }
  if (parsedParams.data.userId === req.currentUser!.id) {
    res.status(400).json({ error: "You cannot suspend your own administrator account." });
    return;
  }
  const [target] = await db
    .select({ id: usersTable.id, role: usersTable.role, isActive: usersTable.isActive, closedAt: usersTable.closedAt })
    .from(usersTable)
    .where(eq(usersTable.id, parsedParams.data.userId))
    .limit(1);
  if (!target) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  if (target.closedAt) {
    res.status(409).json({ error: "This account was closed at the owner's request and cannot be restored." });
    return;
  }
  if (!parsedBody.data.isActive && target.role === "ADMIN" && target.isActive) {
    const [activeAdmins] = await db
      .select({ value: count() })
      .from(usersTable)
      .where(and(eq(usersTable.role, "ADMIN"), eq(usersTable.isActive, true)));
    if (activeAdmins.value <= 1) {
      res.status(409).json({ error: "The last active administrator account cannot be suspended." });
      return;
    }
  }
  const [updated] = await db
    .update(usersTable)
    .set({ isActive: parsedBody.data.isActive, updatedAt: new Date() })
    .where(eq(usersTable.id, target.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  res.json(UpdateAdminUserStatusResponse.parse(userResponse(updated)));
});

router.get("/admin/password-reset-requests", requireAuth("ADMIN"), async (_req, res): Promise<void> => {
  const requests = await db
    .select({
      id: passwordResetRequestsTable.id,
      email: passwordResetRequestsTable.email,
      requestedAt: passwordResetRequestsTable.requestedAt,
    })
    .from(passwordResetRequestsTable)
    .where(isNull(passwordResetRequestsTable.resolvedAt))
    .orderBy(asc(passwordResetRequestsTable.requestedAt));
  res.json(GetAdminPasswordResetRequestsResponse.parse(requests));
});

router.post("/admin/password-reset-requests/:requestId/reset", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const parsedParams = ResetAdminRequestedPasswordParams.safeParse(req.params);
  if (!parsedParams.success) {
    invalidBody(res, "Invalid password reset request.");
    return;
  }

  const temporaryPassword = randomBytes(9).toString("base64url");
  const result = await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(passwordResetRequestsTable)
      .where(and(
        eq(passwordResetRequestsTable.id, parsedParams.data.requestId),
        isNull(passwordResetRequestsTable.resolvedAt),
      ))
      .limit(1);
    if (!request) return null;

    const [account] = await tx
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.email, request.email))
      .limit(1);
    if (!account) {
      await tx
        .update(passwordResetRequestsTable)
        .set({ resolvedAt: new Date(), resolvedBy: req.currentUser!.id })
        .where(eq(passwordResetRequestsTable.id, request.id));
      return null;
    }

    const [resolved] = await tx
      .update(passwordResetRequestsTable)
      .set({ resolvedAt: new Date(), resolvedBy: req.currentUser!.id })
      .where(and(
        eq(passwordResetRequestsTable.id, request.id),
        isNull(passwordResetRequestsTable.resolvedAt),
      ))
      .returning({ id: passwordResetRequestsTable.id });
    if (!resolved) return null;

    await tx
      .update(usersTable)
      .set({ passwordHash: hashPassword(temporaryPassword), sessionVersion: nextSessionVersion() })
      .where(eq(usersTable.id, account.id));
    await tx.insert(auditEventsTable).values({
      actorUserId: req.currentUser!.id,
      action: "TEMPORARY_PASSWORD_ISSUED",
      entityType: "account",
      entityId: account.id,
    });
    return account;
  });

  if (!result) {
    res.status(404).json({ error: "This request is no longer pending or its account no longer exists." });
    return;
  }
  res.json(ResetAdminRequestedPasswordResponse.parse({
    email: result.email,
    temporaryPassword,
  }));
});

router.get("/admin/possible-duplicates", requireAuth("ADMIN"), async (_req, res): Promise<void> => {
  const patients = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      patientDisplayId: usersTable.patientDisplayId,
      sex: usersTable.sex,
      dateOfBirth: usersTable.dateOfBirth,
      dateOfBirthEstimated: usersTable.dateOfBirthEstimated,
      region: usersTable.locationRegion,
      nationalIdNumber: usersTable.nationalIdNumber,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(and(eq(usersTable.role, "PATIENT"), eq(usersTable.isActive, true)))
    .orderBy(asc(usersTable.createdAt));
  // Same name (any word order, accents ignored) and same birth year, unless both sexes are known and differ.
  const byNameAndYear = new Map<string, typeof patients>();
  for (const patient of patients) {
    if (!patient.dateOfBirth) continue;
    const key = `${nameTokens(patient.name).join(" ")}|${patient.dateOfBirth.slice(0, 4)}`;
    byNameAndYear.set(key, [...(byNameAndYear.get(key) ?? []), patient]);
  }
  const toEntry = (patient: (typeof patients)[number]) => ({
    userId: patient.id,
    name: patient.name,
    patientDisplayId: patient.patientDisplayId,
    sex: sexOf(patient.sex),
    dateOfBirth: patient.dateOfBirth,
    dateOfBirthEstimated: patient.dateOfBirthEstimated,
    region: patient.region,
    createdAt: patient.createdAt.toISOString(),
  });
  const groups = [];
  for (const group of byNameAndYear.values()) {
    if (group.length < 2) continue;
    const sexes = new Set(group.map((patient) => patient.sex).filter(Boolean));
    if (sexes.size > 1) continue;
    groups.push({ reason: "SAME_NAME_AND_BIRTH_YEAR" as const, patients: group.map(toEntry) });
  }
  res.json(GetAdminPossibleDuplicatesResponse.parse(groups.slice(0, 100)));
});

router.get("/admin/search-user", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const parsed = SearchUsersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter at least two characters to search." });
    return;
  }
  const query = `%${parsed.data.query.trim()}%`;
  const users = await db
    .select()
    .from(usersTable)
    .where(or(ilike(usersTable.name, query), ilike(usersTable.email, query)))
    .orderBy(desc(usersTable.createdAt))
    .limit(50);
  res.json(SearchUsersResponse.parse(users.map(userResponse)));
});

router.get("/admin/directory", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const uncertified = req.query.uncertified;
  const invalidFlag = uncertified !== undefined && uncertified !== "true" && uncertified !== "false";
  const parsed = GetAdminDirectoryQueryParams.safeParse({
    ...req.query,
    uncertified: uncertified === undefined ? undefined : uncertified === "true",
  });
  if (invalidFlag || !parsed.success || !validDirectoryFilters(parsed.data)) {
    invalidBody(res, "Choose a valid directory type and Cameroon location.");
    return;
  }
  const entries = await adminDirectoryEntries(parsed.data, 500);
  res.json(GetAdminDirectoryResponse.parse(entries));
});

router.get("/admin/directory/export", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const uncertified = req.query.uncertified;
  const invalidFlag = uncertified !== undefined && uncertified !== "true" && uncertified !== "false";
  const parsed = ExportAdminDirectoryQueryParams.safeParse({
    ...req.query,
    uncertified: uncertified === undefined ? undefined : uncertified === "true",
  });
  if (invalidFlag || !parsed.success || !validDirectoryFilters(parsed.data)) {
    invalidBody(res, "Choose a valid directory type and Cameroon location.");
    return;
  }
  const entries = await adminDirectoryEntries(parsed.data, 5000);
  const headers = ["Name", "Directory type", "Region", "Arrondissement", "Hospital or clinic", "Doctor certified"];
  const rows = entries.map((entry) => [
    entry.name,
    entry.kind,
    entry.region,
    entry.arrondissement,
    entry.hospitalName,
    entry.kind === "DOCTORS" ? entry.doctorVerified : null,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const filename = `mon-carnet-${parsed.data.kind.toLowerCase()}-directory.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(`\uFEFF${csv}`);
});

router.post("/admin/notifications", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const parsed = SendAdminNotificationBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter a title and message, then select a valid audience.");
    return;
  }
  const notice = {
    ...parsed.data,
    title: parsed.data.title.trim(),
    body: parsed.data.body.trim(),
  };
  if (!notice.title || !notice.body) {
    invalidBody(res, "Enter a title and message, then select a valid audience.");
    return;
  }

  let recipientIds: number[];
  if (notice.targetType === "ALL") {
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(and(
      eq(usersTable.isActive, true),
    ));
    recipientIds = users.map((user) => user.id);
  } else if (notice.targetType === "REGION" || notice.targetType === "ARRONDISSEMENT") {
    const region = notice.region;
    const arrondissement = notice.targetType === "ARRONDISSEMENT" ? notice.arrondissement : null;
    if (typeof region !== "string" || !isValidCameroonLocation(region, arrondissement)
      || (notice.targetType === "REGION" && notice.arrondissement)
      || (notice.targetType === "ARRONDISSEMENT" && !arrondissement)) {
      invalidBody(res, "Choose a valid region and arrondissement audience.");
      return;
    }
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(and(
      eq(usersTable.isActive, true),
      eq(usersTable.locationRegion, region!),
      ...(arrondissement ? [eq(usersTable.locationArrondissement, arrondissement)] : []),
    ));
    recipientIds = users.map((user) => user.id);
  } else {
    const requestedIds = [...new Set(notice.userIds ?? [])];
    if (requestedIds.length === 0) {
      invalidBody(res, "Select one or more active users for this notification.");
      return;
    }
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(and(
      inArray(usersTable.id, requestedIds),
      eq(usersTable.isActive, true),
    ));
    if (users.length !== requestedIds.length) {
      invalidBody(res, "One or more selected users are unavailable or are not eligible to receive notices.");
      return;
    }
    recipientIds = users.map((user) => user.id);
  }

  if (recipientIds.length === 0) {
    invalidBody(res, "No active users match the selected audience.");
    return;
  }
  const batchId = randomUUID();
  await db.transaction(async (transaction) => {
    for (let offset = 0; offset < recipientIds.length; offset += 500) {
      await transaction.insert(notificationsTable).values(recipientIds.slice(offset, offset + 500).map((recipientId) => ({
        batchId,
        senderId: req.currentUser!.id,
        recipientId,
        title: notice.title,
        body: notice.body,
      })));
    }
  });
  res.status(201).json(SendAdminNotificationResponse.parse({ recipientCount: recipientIds.length }));
});

router.get("/notifications", requireAuth(), async (req, res): Promise<void> => {
  const recipientId = req.currentUser!.id;
  const [unread] = await db.select({ value: count() }).from(notificationsTable).where(and(
    eq(notificationsTable.recipientId, recipientId),
    isNull(notificationsTable.readAt),
  ));
  const items = await db.select({
    id: notificationsTable.id,
    title: notificationsTable.title,
    body: notificationsTable.body,
    createdAt: notificationsTable.createdAt,
    readAt: notificationsTable.readAt,
  }).from(notificationsTable)
    .where(eq(notificationsTable.recipientId, recipientId))
    .orderBy(desc(notificationsTable.createdAt), desc(notificationsTable.id))
    .limit(100);
  res.json(GetNotificationInboxResponse.parse({
    items: items.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      readAt: item.readAt?.toISOString() ?? null,
    })),
    unreadCount: unread.value,
  }));
});

router.put("/notifications/:notificationId/read", requireAuth(), async (req, res): Promise<void> => {
  const parsed = MarkNotificationReadParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid notification." });
    return;
  }
  const [notification] = await db.update(notificationsTable)
    .set({ readAt: sql`coalesce(${notificationsTable.readAt}, now())` })
    .where(and(
      eq(notificationsTable.id, parsed.data.notificationId),
      eq(notificationsTable.recipientId, req.currentUser!.id),
    ))
    .returning();
  if (!notification) {
    res.status(404).json({ error: "Notification not found." });
    return;
  }
  res.json(MarkNotificationReadResponse.parse({
    id: notification.id,
    title: notification.title,
    body: notification.body,
    createdAt: notification.createdAt.toISOString(),
    readAt: notification.readAt?.toISOString() ?? null,
  }));
});

export default router;