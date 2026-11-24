import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accessPermissionsTable,
  db,
  emergencyInfoTable,
  medicalRecordsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./lib/logger";
import { createAuthUser } from "./lib/supabase";

type SeedUser = {
  email: string;
  name: string;
  role: string;
  password: string;
  dateOfBirth?: string;
  contactInfo?: string;
  sex?: "FEMALE" | "MALE";
  countryOfOrigin?: string;
  nationalIdNumber?: string;
  hospitalName?: string;
  // Doctors: their numéro d'ordre at the Ordre National des Médecins du Cameroun (number/year of entry).
  professionalMedicalNumber?: string;
  doctorVerified?: boolean;
  locationRegion?: string;
  locationArrondissement?: string;
};

// Same shape as the CM IDs the app gives patients: "CM" and six letters and digits.
function demoCmId() {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let suffix = "";
  do {
    suffix = Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
  } while (!/[0-9]/.test(suffix) || !/[A-Z]/.test(suffix));
  return `CM${suffix}`;
}

async function ensureUser(input: SeedUser) {
  const email = input.email.toLowerCase();
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (existing) return existing;
  const authUserId = await createAuthUser(email, input.password);
  const [created] = await db
    .insert(usersTable)
    .values({
      email,
      authUserId,
      name: input.name,
      role: input.role,
      dateOfBirth: input.dateOfBirth ?? null,
      contactInfo: input.contactInfo ?? null,
      sex: input.sex ?? null,
      countryOfOrigin: input.countryOfOrigin ?? null,
      nationalIdNumber: input.nationalIdNumber ?? null,
      hospitalName: input.hospitalName ?? null,
      professionalMedicalNumber: input.professionalMedicalNumber ?? null,
      doctorVerified: input.doctorVerified ?? false,
      locationRegion: input.locationRegion ?? null,
      locationArrondissement: input.locationArrondissement ?? null,
      ...(input.role === "PATIENT" ? (() => { const cmId = demoCmId(); return { patientDisplayId: cmId, patientAccessId: cmId }; })() : {}),
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

  await seedCameroonDemo();

  logger.info(
    { adminEmail, seededPatients: patients.length + cameroonPatients.length, seededDoctors: 1 + cameroonDoctors.length },
    "Medichain demo accounts and sample records are ready",
  );
}

// Demo doctors in Cameroon. Numéros d'ordre follow the ONMC roll: entry number/year of entry,
// with a "P" in front for some older entries. All names and numbers are made up.
const cameroonDoctors: SeedUser[] = [
  { email: "dr.ngono@medichain.com", name: "Dr. Christelle Ngono", professionalMedicalNumber: "6554/2013", doctorVerified: true, hospitalName: "Hôpital Général de Douala", locationRegion: "Littoral", locationArrondissement: "Douala 3e", contactInfo: "+237 6 77 41 22 18", sex: "FEMALE" as const },
  { email: "dr.fotso@medichain.com", name: "Dr. Jean-Paul Fotso", professionalMedicalNumber: "P4647/2003", doctorVerified: true, hospitalName: "Hôpital Central de Yaoundé", locationRegion: "Centre", locationArrondissement: "Yaounde 6e", contactInfo: "+237 6 99 12 45 70", sex: "MALE" as const },
  { email: "dr.bello@medichain.com", name: "Dr. Aminatou Bello", professionalMedicalNumber: "9892/2019", doctorVerified: true, hospitalName: "Hôpital Régional de Garoua", locationRegion: "North", locationArrondissement: "Garoua 1er", contactInfo: "+237 6 55 30 81 64", sex: "FEMALE" as const },
  { email: "dr.tchoumi@medichain.com", name: "Dr. Serge Tchoumi", professionalMedicalNumber: "11236/2021", doctorVerified: false, hospitalName: "Hôpital Régional de Bafoussam", locationRegion: "West", locationArrondissement: "Bafoussam 1er", contactInfo: "+237 6 70 58 19 03", sex: "MALE" as const },
  { email: "dr.ekane@medichain.com", name: "Dr. Mary Ekane", professionalMedicalNumber: "14988/2026", doctorVerified: false, hospitalName: "Hôpital Régional de Buea", locationRegion: "South-West", locationArrondissement: "Buea", contactInfo: "+237 6 81 27 64 95", sex: "FEMALE" as const },
].map((doctor) => ({ ...doctor, role: "DOCTOR", password: "doctor123", countryOfOrigin: "CM" }));

// Demo patients. National ID (CNI) numbers are made-up 9-digit numbers, as on Cameroon ID cards.
const cameroonPatients: SeedUser[] = [
  { email: "awa.mballa@medichain.com", name: "Awa Mballa", sex: "FEMALE" as const, dateOfBirth: "1994-02-11", nationalIdNumber: "112458730", contactInfo: "+237 6 77 90 14 52", locationRegion: "Littoral", locationArrondissement: "Douala 5e" },
  { email: "samuel.essomba@medichain.com", name: "Samuel Essomba", sex: "MALE" as const, dateOfBirth: "1979-07-23", nationalIdNumber: "108736215", contactInfo: "+237 6 99 47 31 08", locationRegion: "Centre", locationArrondissement: "Yaounde 3e" },
  { email: "hadjara.oumarou@medichain.com", name: "Hadjara Oumarou", sex: "FEMALE" as const, dateOfBirth: "2001-11-05", nationalIdNumber: "120563917", contactInfo: "+237 6 55 82 06 39", locationRegion: "North", locationArrondissement: "Garoua 1er" },
  { email: "brice.kamga@medichain.com", name: "Brice Kamga", sex: "MALE" as const, dateOfBirth: "1988-04-30", nationalIdNumber: "114092684", contactInfo: "+237 6 70 13 77 41", locationRegion: "West", locationArrondissement: "Dschang" },
  { email: "grace.nkwenti@medichain.com", name: "Grace Nkwenti", sex: "FEMALE" as const, dateOfBirth: "1996-09-14", nationalIdNumber: "117345026", contactInfo: "+237 6 81 66 25 90", locationRegion: "South-West", locationArrondissement: "Buea" },
  { email: "paul.abena@medichain.com", name: "Paul Abena", sex: "MALE" as const, dateOfBirth: "1965-01-08", nationalIdNumber: "101827463", contactInfo: "+237 6 96 04 58 12", locationRegion: "South", locationArrondissement: "Ebolowa 1er" },
].map((patient) => ({ ...patient, role: "PATIENT", password: "patient123", countryOfOrigin: "CM" }));

const cameroonEmergencyInfo = [
  { bloodGroup: "O+", weightKg: 61, heightCm: 164, allergies: "Aucune allergie connue", emergencyContact: "Ibrahim Mballa · +237 6 77 90 14 00" },
  { bloodGroup: "B+", weightKg: 84, heightCm: 178, allergies: "Pénicilline", emergencyContact: "Marie Essomba · +237 6 99 47 31 00" },
  { bloodGroup: "A+", weightKg: 55, heightCm: 160, allergies: "Aucune allergie connue", emergencyContact: "Moussa Oumarou · +237 6 55 82 06 00" },
  { bloodGroup: "AB+", weightKg: 76, heightCm: 175, allergies: "Arachides", emergencyContact: "Odile Kamga · +237 6 70 13 77 00" },
  { bloodGroup: "O-", weightKg: 63, heightCm: 167, allergies: "Sulfamides", emergencyContact: "Peter Nkwenti · +237 6 81 66 25 00" },
  { bloodGroup: "A-", weightKg: 79, heightCm: 172, allergies: "Aucune allergie connue", emergencyContact: "Jeanne Abena · +237 6 96 04 58 00" },
];

// Each patient is followed by the doctor in the same region (the last one by the doctor in Yaoundé).
const cameroonRecords = [
  { doctor: 0, recordType: "Consultation", diagnosis: "Paludisme simple", treatment: "Artéméther-luméfantrine pendant 3 jours", medications: ["Artéméther-luméfantrine", "Paracétamol"], vitals: { bloodPressure: "112/70", heartRate: 88, temperature: 38.4, weightKg: 61 } },
  { doctor: 1, recordType: "Consultation", diagnosis: "Hypertension artérielle, suivi", treatment: "Poursuivre le traitement, contrôle dans 3 mois", medications: ["Amlodipine 5 mg"], vitals: { bloodPressure: "148/92", heartRate: 76, temperature: 36.8, weightKg: 84 } },
  { doctor: 2, recordType: "Follow-up", diagnosis: "Consultation prénatale, 24 semaines, sans particularité", treatment: "Supplémentation, prochain rendez-vous dans 4 semaines", medications: ["Fer + acide folique"], vitals: { bloodPressure: "110/68", heartRate: 82, temperature: 36.6, weightKg: 55 } },
  { doctor: 3, recordType: "Lab Results", diagnosis: "Glycémie à jeun normale", treatment: "Aucun traitement nécessaire", medications: [], vitals: { bloodPressure: "120/78", heartRate: 70, temperature: 36.7, weightKg: 76 } },
  { doctor: 4, recordType: "Treatment", diagnosis: "Rappel antitétanique", treatment: "Vaccin administré, aucune réaction", medications: [], vitals: { bloodPressure: "116/74", heartRate: 72, temperature: 36.5, weightKg: 63 } },
  { doctor: 1, recordType: "Consultation", diagnosis: "Diabète de type 2, suivi", treatment: "Régime et activité physique, contrôle de l'HbA1c dans 3 mois", medications: ["Metformine 850 mg"], vitals: { bloodPressure: "134/84", heartRate: 74, temperature: 36.9, weightKg: 79 } },
];

async function seedCameroonDemo() {
  const doctors = [];
  for (const doctor of cameroonDoctors) doctors.push(await ensureUser(doctor));
  const patients = [];
  for (const patient of cameroonPatients) patients.push(await ensureUser(patient));

  await db
    .insert(emergencyInfoTable)
    .values(patients.map((patient, index) => ({ userId: patient.id, ...cameroonEmergencyInfo[index] })))
    .onConflictDoNothing({ target: emergencyInfoTable.userId });

  for (const [index, patient] of patients.entries()) {
    const record = cameroonRecords[index];
    const doctor = doctors[record.doctor];
    const [existingRecord] = await db
      .select({ id: medicalRecordsTable.id })
      .from(medicalRecordsTable)
      .where(eq(medicalRecordsTable.patientId, patient.id))
      .limit(1);
    if (!existingRecord) {
      await db.insert(medicalRecordsTable).values({
        patientId: patient.id,
        doctorId: doctor.id,
        recordType: record.recordType,
        diagnosis: record.diagnosis,
        treatment: record.treatment,
        medications: record.medications,
        notes: "Dossier fictif pour la démo Mon carnet. Aucune donnée réelle.",
        vitals: record.vitals,
      });
    }
    await db
      .insert(accessPermissionsTable)
      .values({
        patientId: patient.id,
        doctorId: doctor.id,
        granted: true,
        grantedVia: "PATIENT",
        expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
      })
      .onConflictDoNothing({
        target: [accessPermissionsTable.patientId, accessPermissionsTable.doctorId],
      });
  }
}

seed()
  .catch((error: unknown) => {
    logger.error({ error }, "Unable to seed Medichain demo data");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });