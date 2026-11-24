// Corrections to a medical record by the doctor who wrote it, within the edit window, and the
// history of earlier versions. Everything else about records stays as it was: after the window,
// corrections are linked follow-up records; nobody else can change a record; nothing is deleted.
import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditEventsTable,
  db,
  medicalRecordVersionsTable,
  medicalRecordsTable,
  notificationsTable,
  usersTable,
} from "@workspace/db";
import {
  EditDoctorPatientRecordBody,
  EditDoctorPatientRecordParams,
  EditDoctorPatientRecordResponse,
  GetMedicalRecordHistoryResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/medichain-auth";
import { languageOf, notificationMessages } from "../lib/notification-messages";
import { codedDiagnosesForRecord, getActivePermission, invalidBody, recordEditableUntil, recordResponse } from "./medichain";

const router: IRouter = Router();
const ATTACHMENT_LINES = /(?:^|\r?\n)Attachment: [^\r\n]*\r?\nAttachment object: [^\r\n]*/g;

router.put("/doctor/patient/:patientId/records/:recordId", requireAuth("DOCTOR"), async (req, res): Promise<void> => {
  const params = EditDoctorPatientRecordParams.safeParse(req.params);
  const body = EditDoctorPatientRecordBody.safeParse(req.body);
  if (!params.success || !body.success) {
    invalidBody(res, "Check the record details and give a reason for the correction (at least 5 characters).");
    return;
  }
  const doctor = req.currentUser!;
  const { patientId, recordId } = params.data;
  if (!(await getActivePermission(patientId, doctor.id))) {
    res.status(403).json({ error: "You do not have access to this patient's booklet. Enter their CM ID to send a request, then wait for the patient's approval." });
    return;
  }
  const [record] = await db.select().from(medicalRecordsTable).where(and(eq(medicalRecordsTable.id, recordId), eq(medicalRecordsTable.patientId, patientId))).limit(1);
  if (!record) {
    res.status(404).json({ error: "Record not found for this patient." });
    return;
  }
  if (record.doctorId !== doctor.id) {
    res.status(403).json({ error: "Only the doctor who wrote a record can correct it. Add a linked follow-up instead." });
    return;
  }
  if (!recordEditableUntil(record, doctor.id)) {
    res.status(409).json({ error: "The time to correct this record is over. Add a linked follow-up instead." });
    return;
  }
  const reason = body.data.reason.trim();
  if (reason.length < 5) {
    invalidBody(res, "Check the record details and give a reason for the correction (at least 5 characters).");
    return;
  }
  // References to attached lab files stay exactly as they were.
  const attachments = record.notes.match(ATTACHMENT_LINES) ?? [];
  const notes = [body.data.notes.replace(ATTACHMENT_LINES, "").trim(), ...attachments.map((lines) => lines.trim())].filter(Boolean).join("\n\n");
  const updated = await db.transaction(async (tx) => {
    // Lock the record so two corrections at once cannot both save the same version number.
    const [current] = await tx.select().from(medicalRecordsTable).where(eq(medicalRecordsTable.id, record.id)).for("update");
    if (!current) return null;
    await tx.insert(medicalRecordVersionsTable).values({
      recordId: current.id,
      version: current.editCount + 1,
      diagnosis: current.diagnosis,
      treatment: current.treatment,
      medications: current.medications,
      notes: current.notes,
      vitals: current.vitals ?? {},
      replacedBy: doctor.id,
      changeReason: reason,
    });
    const [saved] = await tx.update(medicalRecordsTable).set({
      diagnosis: body.data.diagnosis,
      treatment: body.data.treatment,
      medications: body.data.medications,
      notes,
      vitals: body.data.vitals,
      editedAt: new Date(),
      editCount: sql`${medicalRecordsTable.editCount} + 1`,
    }).where(eq(medicalRecordsTable.id, current.id)).returning();
    await tx.insert(auditEventsTable).values({
      actorUserId: doctor.id,
      patientId,
      action: "MEDICAL_RECORD_EDITED",
      entityType: "medical_record",
      entityId: current.id,
      hospitalName: doctor.hospitalName,
    });
    const [patient] = await tx.select({ preferredLanguage: usersTable.preferredLanguage }).from(usersTable).where(eq(usersTable.id, patientId)).limit(1);
    await tx.insert(notificationsTable).values({
      batchId: randomUUID(),
      senderId: doctor.id,
      recipientId: patientId,
      ...notificationMessages.recordCorrected(languageOf(patient?.preferredLanguage), doctor.name, current.recordType, reason),
    });
    return saved!;
  });
  if (!updated) {
    res.status(404).json({ error: "Record not found for this patient." });
    return;
  }
  res.json(EditDoctorPatientRecordResponse.parse(recordResponse(updated, doctor.name, await codedDiagnosesForRecord(updated.id), doctor.id)));
});

router.get("/records/:recordId/history", requireAuth("PATIENT", "DOCTOR"), async (req, res): Promise<void> => {
  const recordId = Number(req.params.recordId);
  if (!Number.isInteger(recordId) || recordId < 1) {
    res.status(400).json({ error: "Invalid record." });
    return;
  }
  const [record] = await db.select({ patientId: medicalRecordsTable.patientId }).from(medicalRecordsTable).where(eq(medicalRecordsTable.id, recordId)).limit(1);
  const current = req.currentUser!;
  const allowed = record && (current.role === "PATIENT" ? record.patientId === current.id : Boolean(await getActivePermission(record.patientId, current.id)));
  if (!allowed) {
    // The same answer for a record that does not exist and one that is not yours to see.
    res.status(404).json({ error: "Record not found." });
    return;
  }
  const versions = await db
    .select({ version: medicalRecordVersionsTable, replacedByName: usersTable.name })
    .from(medicalRecordVersionsTable)
    .leftJoin(usersTable, eq(medicalRecordVersionsTable.replacedBy, usersTable.id))
    .where(eq(medicalRecordVersionsTable.recordId, recordId))
    .orderBy(desc(medicalRecordVersionsTable.version));
  res.json(GetMedicalRecordHistoryResponse.parse(versions.map(({ version, replacedByName }) => ({
    version: version.version,
    diagnosis: version.diagnosis,
    treatment: version.treatment,
    medications: version.medications,
    notes: version.notes,
    vitals: version.vitals ?? {},
    replacedAt: version.replacedAt.toISOString(),
    replacedByName: replacedByName ?? "Doctor",
    changeReason: version.changeReason,
  }))));
});

export default router;
