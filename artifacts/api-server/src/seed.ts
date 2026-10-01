import { and, eq } from "drizzle-orm";
import {
  accessPermissionsTable,
  db,
  emergencyInfoTable,
  medicalRecordsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./lib/logger";
import { hashPassword } from "./lib/medichain-auth";

async function ensureUser(input: {
  email: string;
  name: string;
  role: string;
  password: string;
  dateOfBirth?: string;
  contactInfo?: string;
}) {
  const email = input.email.toLowerCase();
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(usersTable)
    .values({
      email,
      name: input.name,
      role: input.role,
      passwordHash: hashPassword(input.password),
      dateOfBirth: input.dateOfBirth ?? null,
      contactInfo: input.contactInfo ?? null,
      isActive: true,
    })
    .returning();
  return created;
}

async function seed() {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() || "admin@medichain.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  await ensureUser({
    email: adminEmail,
    name: "Medichain Administrator",
    role: "ADMIN",
    password: adminPassword,
  });

  const doctor = await ensureUser({
    email: "dr.maya@medichain.com",
    name: "Dr. Maya Bennett",
    role: "DOCTOR",
    password: "doctor123",
    contactInfo: "+1 (555) 014-2048",
  });
  const patients = await Promise.all([
    ensureUser({
      email: "olivia.carter@medichain.com",
      name: "Olivia Carter",
      role: "PATIENT",
      password: "patient123",
      dateOfBirth: "1991-04-18",
      contactInfo: "+1 (555) 014-2190",
    }),
    ensureUser({
      email: "noah.williams@medichain.com",
      name: "Noah Williams",
      role: "PATIENT",
      password: "patient123",
      dateOfBirth: "1985-09-03",
      contactInfo: "+1 (555) 014-2775",
    }),
  ]);

  await db
    .insert(emergencyInfoTable)
    .values([
      {
        userId: patients[0].id,
        bloodGroup: "O+",
        weightKg: 64,
        heightCm: 168,
        allergies: "Penicillin",
        emergencyContact: "James Carter · +1 (555) 014-2100",
      },
      {
        userId: patients[1].id,
        bloodGroup: "A-",
        weightKg: 82,
        heightCm: 181,
        allergies: "No known allergies",
        emergencyContact: "Amelia Williams · +1 (555) 014-2700",
      },
    ])
    .onConflictDoNothing({ target: emergencyInfoTable.userId });

  for (const patient of patients) {
    const [existingRecord] = await db
      .select({ id: medicalRecordsTable.id })
      .from(medicalRecordsTable)
      .where(eq(medicalRecordsTable.patientId, patient.id))
      .limit(1);
    if (!existingRecord) {
      await db.insert(medicalRecordsTable).values({
        patientId: patient.id,
        doctorId: doctor.id,
        recordType: patient.id === patients[0].id ? "Consultation" : "Lab Results",
        diagnosis:
          patient.id === patients[0].id
            ? "Routine annual wellness visit"
            : "Routine blood panel within expected ranges",
        treatment:
          patient.id === patients[0].id
            ? "Continue current wellness plan"
            : "No treatment required",
        medications: patient.id === patients[0].id ? ["Vitamin D"] : [],
        notes: "Sample record for the Medichain demo. No real patient data.",
        vitals: {
          bloodPressure: patient.id === patients[0].id ? "118/76" : "122/80",
          heartRate: patient.id === patients[0].id ? 72 : 68,
          temperature: 36.7,
          weightKg: patient.id === patients[0].id ? 64 : 82,
        },
      });
    }
  }

  await db
    .insert(accessPermissionsTable)
    .values({
      patientId: patients[0].id,
      doctorId: doctor.id,
      granted: true,
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing({
      target: [accessPermissionsTable.patientId, accessPermissionsTable.doctorId],
    });

  logger.info(
    { adminEmail, seededPatients: patients.length },
    "Medichain demo accounts and sample records are ready",
  );
}

seed()
  .catch((error: unknown) => {
    logger.error({ error }, "Unable to seed Medichain demo data");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });