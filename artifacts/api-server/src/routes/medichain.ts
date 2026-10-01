import { Router, type IRouter, type Response } from "express";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  ilike,
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
  SearchUsersQueryParams,
  SearchUsersResponse,
  UpdateEmergencyInfoBody,
  UpdateEmergencyInfoResponse,
} from "@workspace/api-zod";
import { db, usersTable, emergencyInfoTable, medicalRecordsTable, accessPermissionsTable, patientSearchesTable } from "@workspace/db";
import { createAccessToken, hashPassword, publicUser, requireAuth, userResponse, verifyPassword } from "../lib/medichain-auth";

const router: IRouter = Router();

function invalidBody(res: Response, message: string) {
  res.status(400).json({ error: message });
}

function recordResponse(record: typeof medicalRecordsTable.$inferSelect, doctorName: string) {
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
  res.json(
    GetPatientRecordsResponse.parse(
      rows.map((row) => recordResponse(row.record, row.doctorName)),
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

router.get("/doctor/profile", requireAuth("DOCTOR"), async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.currentUser!.id)).limit(1);
  if (!user) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json(GetDoctorProfileResponse.parse(userResponse(user)));
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
      const permission = await getActivePermission(patient.id, doctorId);
      await db.insert(patientSearchesTable).values({ patientId: patient.id, doctorId });
      return {
        user: userResponse(patient),
        emergencyInfo: emergency ? emergencyResponse(emergency, patient.name) : null,
        hasAccess: Boolean(permission),
        expiresAt: permission?.expiresAt.toISOString() ?? null,
      };
    }),
  );
  res.json(SearchPatientsResponse.parse(results));
});

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
    res.json(
      GetDoctorPatientRecordsResponse.parse(
        rows.map((row) => recordResponse(row.record, row.doctorName)),
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
    const isFollowUp = body.data.recordType === "Follow-up";
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
    const [record] = await db
      .insert(medicalRecordsTable)
      .values({
        patientId,
        doctorId: req.currentUser!.id,
        recordType: body.data.recordType,
        diagnosis: body.data.diagnosis,
        treatment: body.data.treatment,
        medications: body.data.medications,
        notes: body.data.notes,
        followUpToRecordId,
        vitals: body.data.vitals,
      })
      .returning();
    res.status(201).json(
      AddDoctorPatientRecordResponse.parse(
        recordResponse(record, req.currentUser!.name),
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