import { Router, type IRouter, type Response } from "express";
import {
  randomUUID,
} from "node:crypto";
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
  ilike,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  AddDoctorPatientRecordBody,
  AddDoctorPatientRecordParams,
  AddDoctorPatientRecordResponse,
  ApproveDoctorParams,
  ApproveDoctorResponse,
  GrantPatientPermissionBody,
  GrantPatientPermissionResponse,
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
  RegisterBody,
  RegisterResponse,
  RevokeDoctorParams,
  RevokeDoctorResponse,
  RevokePatientPermissionParams,
  RevokePatientPermissionResponse,
  SearchPatientsQueryParams,
  SearchPatientsResponse,
  SearchDiseaseCodesQueryParams,
  SearchDiseaseCodesResponse,
  SearchUsersQueryParams,
  SearchUsersResponse,
  UpdateEmergencyInfoBody,
  UpdateEmergencyInfoResponse,
} from "@workspace/api-zod";
import {
  auditEventsTable,
  db,
  diseaseCodesTable,
  usersTable,
  emergencyInfoTable,
  medicalDiagnosesTable,
  medicalAttachmentsTable,
  medicalRecordsTable,
  accessPermissionsTable,
  patientSearchesTable,
} from "@workspace/db";
import { createAccessToken, hashPassword, publicUser, requireAuth, userResponse, verifyPassword } from "../lib/medichain-auth";

const router: IRouter = Router();

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

async function createSignedObjectUrl(objectPath: string, method: "PUT" | "GET" | "DELETE", ttlSeconds: number) {
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

function invalidBody(res: Response, message: string) {
  res.status(400).json({ error: message });
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

async function recordsResponse(
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

function emergencyResponse(
  info: typeof emergencyInfoTable.$inferSelect,
  patientName: string,
) {
  return {
    patientId: info.userId,
    patientName,
    bloodGroup: info.bloodGroup,
    weightKg: info.weightKg,
    heightCm: info.heightCm,
    allergies: info.allergies,
    emergencyContact: info.emergencyContact,
    updatedAt: info.updatedAt.toISOString(),
  };
}

async function getActivePermission(patientId: number, doctorId: number) {
  const [permission] = await db
    .select()
    .from(accessPermissionsTable)
    .where(
      and(
        eq(accessPermissionsTable.patientId, patientId),
        eq(accessPermissionsTable.doctorId, doctorId),
        eq(accessPermissionsTable.granted, true),
        gte(accessPermissionsTable.expiresAt, new Date()),
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
    granted: permission.granted,
    grantedAt: permission.grantedAt.toISOString(),
    expiresAt: permission.expiresAt.toISOString(),
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
  if (!input.contactInfo?.trim() || (input.role === "PATIENT" && !input.dateOfBirth)) {
    invalidBody(
      res,
      input.role === "PATIENT"
        ? "Patient registration requires a date of birth and contact information."
        : "Doctor registration requires contact information.",
    );
    return;
  }

  try {
    const [created] = await db
      .insert(usersTable)
      .values({
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        passwordHash: hashPassword(input.password),
        role: input.role === "DOCTOR" ? "PENDING_DOCTOR" : "PATIENT",
        dateOfBirth:
          input.role === "PATIENT" && input.dateOfBirth
            ? input.dateOfBirth.toISOString().slice(0, 10)
            : null,
        contactInfo: input.contactInfo?.trim() || null,
      })
      .returning();
    const user = publicUser(created);
    res.status(201).json(
      RegisterResponse.parse({
        token: createAccessToken(user),
        user: userResponse(created),
      }),
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
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
  const current = publicUser(user);
  res.json(
    LoginResponse.parse({
      token: createAccessToken(current),
      user: userResponse(user),
    }),
  );
});

router.get("/auth/me", requireAuth(), async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.currentUser!.id)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.json(GetMeResponse.parse(userResponse(user)));
});

router.get("/patient/profile", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
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
    .where(and(eq(accessPermissionsTable.patientId, userId), eq(accessPermissionsTable.granted, true)));
  res.json(
    GetPatientProfileResponse.parse({
      user: userResponse(user),
      emergencyInfo: emergency ? emergencyResponse(emergency, user.name) : null,
      recordCount: records.value,
      permissionsCount: permissions.value,
    }),
  );
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
  const [user] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId));
  res.json(
    UpdateEmergencyInfoResponse.parse(
      emergencyResponse(saved, user?.name ?? "Patient"),
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
    await db
      .update(accessPermissionsTable)
      .set({ granted: false, expiresAt: new Date() })
      .where(
        and(
          eq(accessPermissionsTable.patientId, req.currentUser!.id),
          eq(accessPermissionsTable.doctorId, parsed.data.doctorId),
        ),
      );
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
        searchedAt: row.search.searchedAt.toISOString(),
      });
    }
  }
  res.json(GetPatientPendingRequestsResponse.parse(response));
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
  const hospitalName = typeof req.body?.hospitalName === "string" ? req.body.hospitalName.trim() : null;
  if (hospitalName === null || hospitalName.length > 180) {
    invalidBody(res, "Enter a hospital or clinic name up to 180 characters.");
    return;
  }
  const [updated] = await db.update(usersTable)
    .set({ hospitalName: hospitalName || null })
    .where(eq(usersTable.id, req.currentUser!.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Doctor profile not found." });
    return;
  }
  res.json(userResponse(updated));
});

router.get("/doctor/search-patient", requireAuth("DOCTOR"), async (req, res): Promise<void> => {
  const parsed = SearchPatientsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter at least two characters to search." });
    return;
  }
  const query = parsed.data.query.trim();
  const patients = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.role, "PATIENT"),
        eq(usersTable.isActive, true),
        or(ilike(usersTable.name, `%${query}%`), ilike(usersTable.email, `%${query}%`)),
      ),
    )
    .limit(25);
  const doctorId = req.currentUser!.id;
  const results = await Promise.all(
    patients.map(async (patient) => {
      const [emergency] = await db
        .select()
        .from(emergencyInfoTable)
        .where(eq(emergencyInfoTable.userId, patient.id))
        .limit(1);
      await db.insert(patientSearchesTable).values({ patientId: patient.id, doctorId });
      if (!emergency) return null;
      await db.insert(auditEventsTable).values({
        actorUserId: doctorId,
        patientId: patient.id,
        action: "EMERGENCY_INFO_VIEWED",
        entityType: "emergency_info",
        hospitalName: req.currentUser!.hospitalName,
      });
      return { emergencyInfo: emergencyResponse(emergency, patient.name) };
    }),
  );
  res.json(SearchPatientsResponse.parse(results.filter((result) => result !== null)));
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
    res.json(GetPatientEmergencyResponse.parse(emergencyResponse(info, patient.name)));
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
        gte(accessPermissionsTable.expiresAt, new Date()),
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
    .where(and(eq(accessPermissionsTable.granted, true), gte(accessPermissionsTable.expiresAt, new Date())));
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
      systemStatus: [
        { name: "API services", status: "Operational" },
        { name: "Database", status: "Operational" },
        { name: "Access controls", status: "Operational" },
      ],
    }),
  );
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

export default router;