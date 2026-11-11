// Account rights under Cameroon's personal data protection law (Law 2024/017) and app-store rules:
// download your data, request deletion, and administrator handling of deletion requests.
import { Router, type IRouter } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, or } from "drizzle-orm";
import {
  accessPermissionsTable,
  accessRequestsTable,
  accountDeletionRequestsTable,
  auditEventsTable,
  bookletExportsTable,
  db,
  emergencyInfoTable,
  medicalAttachmentsTable,
  medicalRecordsTable,
  notificationsTable,
  passwordResetRequestsTable,
  patientSearchesTable,
  usersTable,
} from "@workspace/db";
import {
  AcceptLegalTermsBody,
  AcceptLegalTermsResponse,
  LEGAL_DOCUMENTS_VERSION,
  CancelAccountDeletionResponse,
  GetAdminDeletionRequestsResponse,
  GetMyDeletionRequestResponse,
  RequestAccountDeletionBody,
  RequestAccountDeletionResponse,
  ResolveAdminDeletionRequestBody,
  ResolveAdminDeletionRequestParams,
  ResolveAdminDeletionRequestResponse,
} from "@workspace/api-zod";
import { requireAuth, userResponse, verifyAccountPassword } from "../lib/medichain-auth";
import { deleteAuthUser } from "../lib/supabase";
import { languageOf, notificationMessages } from "../lib/notification-messages";
import { recordSecurityEvent } from "../lib/security-events";
import { accountSecretLimiter } from "../lib/rate-limits";
import { emergencyResponse, invalidBody, isUniqueViolation, recordsResponse } from "./medichain";
import { deleteStoredFiles } from "../lib/object-storage";

const router: IRouter = Router();

type DeletionRow = typeof accountDeletionRequestsTable.$inferSelect;

function deletionResponse(row: DeletionRow) {
  return {
    id: row.id,
    status: row.status,
    outcome: row.outcome,
    reason: row.reason,
    resolutionNote: row.resolutionNote,
    requestedAt: row.requestedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

router.post("/account/consent", requireAuth(), async (req, res): Promise<void> => {
  const parsed = AcceptLegalTermsBody.safeParse(req.body);
  const isPatient = req.currentUser!.role === "PATIENT";
  if (!parsed.success || parsed.data.termsVersion !== LEGAL_DOCUMENTS_VERSION || (isPatient && !parsed.data.healthDataConsent)) {
    invalidBody(res, "Accept the current terms of use and privacy policy. Patients must also consent to the processing of their health data.");
    return;
  }
  const now = new Date();
  const [updated] = await db
    .update(usersTable)
    .set({ termsVersion: LEGAL_DOCUMENTS_VERSION, termsAcceptedAt: now, ...(isPatient ? { healthDataConsentAt: now } : {}) })
    .where(eq(usersTable.id, req.currentUser!.id))
    .returning();
  await db.insert(auditEventsTable).values({
    actorUserId: req.currentUser!.id,
    patientId: isPatient ? req.currentUser!.id : null,
    action: "LEGAL_TERMS_ACCEPTED",
    entityType: "account",
    entityId: req.currentUser!.id,
  });
  res.json(AcceptLegalTermsResponse.parse(userResponse(updated!)));
});

router.get("/account/data-export", requireAuth(), async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const notifications = await db
    .select({ title: notificationsTable.title, body: notificationsTable.body, createdAt: notificationsTable.createdAt, readAt: notificationsTable.readAt })
    .from(notificationsTable)
    .where(eq(notificationsTable.recipientId, userId))
    .orderBy(desc(notificationsTable.createdAt));
  const ownActions = await db
    .select({ action: auditEventsTable.action, hospitalName: auditEventsTable.hospitalName, createdAt: auditEventsTable.createdAt })
    .from(auditEventsTable)
    .where(eq(auditEventsTable.actorUserId, userId))
    .orderBy(desc(auditEventsTable.createdAt));
  const deletionRequests = await db
    .select()
    .from(accountDeletionRequestsTable)
    .where(eq(accountDeletionRequestsTable.userId, userId))
    .orderBy(desc(accountDeletionRequestsTable.requestedAt));

  const data: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    notice: "Personal data held by Mon carnet for this account. Medical records are copies of entries written by your care team.",
    account: {
      ...userResponse(user),
      ...(user.role === "PATIENT"
        ? { patientDisplayId: user.patientDisplayId, nationalIdNumber: user.nationalIdNumber, accessApprovalMode: user.accessApprovalMode }
        : {}),
    },
    notifications,
    actionsYouTook: ownActions,
    deletionRequests: deletionRequests.map(deletionResponse),
  };

  if (user.role === "PATIENT") {
    const [emergency] = await db.select().from(emergencyInfoTable).where(eq(emergencyInfoTable.userId, userId)).limit(1);
    const recordRows = await db
      .select({ record: medicalRecordsTable, doctorName: usersTable.name })
      .from(medicalRecordsTable)
      .innerJoin(usersTable, eq(medicalRecordsTable.doctorId, usersTable.id))
      .where(eq(medicalRecordsTable.patientId, userId))
      .orderBy(asc(medicalRecordsTable.createdAt));
    const permissions = await db
      .select({ doctorName: usersTable.name, granted: accessPermissionsTable.granted, grantedAt: accessPermissionsTable.grantedAt, expiresAt: accessPermissionsTable.expiresAt })
      .from(accessPermissionsTable)
      .innerJoin(usersTable, eq(accessPermissionsTable.doctorId, usersTable.id))
      .where(eq(accessPermissionsTable.patientId, userId));
    const accessRequests = await db
      .select({ doctorName: usersTable.name, hospitalName: accessRequestsTable.hospitalName, status: accessRequestsTable.status, requestedAt: accessRequestsTable.requestedAt, resolvedAt: accessRequestsTable.resolvedAt })
      .from(accessRequestsTable)
      .innerJoin(usersTable, eq(accessRequestsTable.doctorId, usersTable.id))
      .where(eq(accessRequestsTable.patientId, userId));
    const lookups = await db
      .select({ doctorName: usersTable.name, hospitalName: patientSearchesTable.hospitalName, reason: patientSearchesTable.reason, searchedAt: patientSearchesTable.searchedAt })
      .from(patientSearchesTable)
      .innerJoin(usersTable, eq(patientSearchesTable.doctorId, usersTable.id))
      .where(eq(patientSearchesTable.patientId, userId));
    const accessHistory = await db
      .select({ by: usersTable.name, action: auditEventsTable.action, hospitalName: auditEventsTable.hospitalName, createdAt: auditEventsTable.createdAt })
      .from(auditEventsTable)
      .innerJoin(usersTable, eq(auditEventsTable.actorUserId, usersTable.id))
      .where(eq(auditEventsTable.patientId, userId))
      .orderBy(desc(auditEventsTable.createdAt));
    const booklets = await db
      .select({ verificationCode: bookletExportsTable.verificationCode, recordCount: bookletExportsTable.recordCount, issuedAt: bookletExportsTable.issuedAt })
      .from(bookletExportsTable)
      .where(eq(bookletExportsTable.patientId, userId));
    Object.assign(data, {
      emergencyInformation: emergency ? emergencyResponse(emergency, user) : null,
      medicalRecords: await recordsResponse(recordRows),
      doctorAccess: permissions,
      doctorAccessRequests: accessRequests,
      emergencyLookups: lookups,
      recordAccessHistory: accessHistory,
      bookletsIssued: booklets,
    });
  }

  await db.insert(auditEventsTable).values({
    actorUserId: userId,
    patientId: user.role === "PATIENT" ? userId : null,
    action: "PERSONAL_DATA_EXPORTED",
    entityType: "account",
    entityId: userId,
  });
  res.setHeader("Content-Disposition", `attachment; filename="mon-carnet-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
});

router.get("/account/deletion-request", requireAuth(), async (req, res): Promise<void> => {
  const [latest] = await db
    .select()
    .from(accountDeletionRequestsTable)
    .where(eq(accountDeletionRequestsTable.userId, req.currentUser!.id))
    .orderBy(desc(accountDeletionRequestsTable.requestedAt))
    .limit(1);
  res.json(GetMyDeletionRequestResponse.parse(latest ? deletionResponse(latest) : null));
});

router.post("/account/deletion-request", requireAuth(), accountSecretLimiter, async (req, res): Promise<void> => {
  const parsed = RequestAccountDeletionBody.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, "Enter your password to confirm the request.");
    return;
  }
  const current = req.currentUser!;
  if (current.role === "ADMIN") {
    res.status(403).json({ error: "Administrator accounts are closed by another administrator." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, current.id)).limit(1);
  if (!user || !(await verifyAccountPassword(user, parsed.data.password))) {
    res.status(403).json({ error: "Current password is incorrect." });
    return;
  }
  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(accountDeletionRequestsTable)
        .values({ userId: user.id, role: user.role, reason: parsed.data.reason?.trim() || null })
        .returning();
      await tx.insert(auditEventsTable).values({
        actorUserId: user.id,
        patientId: user.role === "PATIENT" ? user.id : null,
        action: "ACCOUNT_DELETION_REQUESTED",
        entityType: "account_deletion_request",
        entityId: row!.id,
      });
      const admins = await tx
        .select({ id: usersTable.id, preferredLanguage: usersTable.preferredLanguage })
        .from(usersTable)
        .where(and(eq(usersTable.role, "ADMIN"), eq(usersTable.isActive, true)));
      if (admins.length) {
        await tx.insert(notificationsTable).values(admins.map((admin) => ({
          batchId: randomUUID(),
          senderId: null,
          recipientId: admin.id,
          ...notificationMessages.deletionRequested(languageOf(admin.preferredLanguage), user.name),
        })));
      }
      return row!;
    });
    res.status(201).json(RequestAccountDeletionResponse.parse(deletionResponse(created)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "A deletion request for this account is already waiting." });
      return;
    }
    throw error;
  }
});

router.delete("/account/deletion-request", requireAuth(), async (req, res): Promise<void> => {
  const [cancelled] = await db
    .update(accountDeletionRequestsTable)
    .set({ status: "CANCELLED", resolvedAt: new Date() })
    .where(and(eq(accountDeletionRequestsTable.userId, req.currentUser!.id), eq(accountDeletionRequestsTable.status, "PENDING")))
    .returning();
  if (!cancelled) {
    res.status(404).json({ error: "There is no deletion request waiting." });
    return;
  }
  await db.insert(auditEventsTable).values({
    actorUserId: req.currentUser!.id,
    patientId: req.currentUser!.role === "PATIENT" ? req.currentUser!.id : null,
    action: "ACCOUNT_DELETION_CANCELLED",
    entityType: "account_deletion_request",
    entityId: cancelled.id,
  });
  CancelAccountDeletionResponse.parse(undefined);
  res.status(204).send();
});

router.get("/admin/deletion-requests", requireAuth("ADMIN"), async (_req, res): Promise<void> => {
  const rows = await db
    .select({ request: accountDeletionRequestsTable, user: usersTable })
    .from(accountDeletionRequestsTable)
    .innerJoin(usersTable, eq(accountDeletionRequestsTable.userId, usersTable.id))
    .where(eq(accountDeletionRequestsTable.status, "PENDING"))
    .orderBy(asc(accountDeletionRequestsTable.requestedAt));
  const result = [];
  for (const { request, user } of rows) {
    const recordFilter = user.role === "PATIENT" ? eq(medicalRecordsTable.patientId, user.id) : eq(medicalRecordsTable.doctorId, user.id);
    const attachmentFilter = user.role === "PATIENT" ? eq(medicalAttachmentsTable.patientId, user.id) : eq(medicalAttachmentsTable.doctorId, user.id);
    const [records] = await db.select({ value: count() }).from(medicalRecordsTable).where(recordFilter);
    const [attachments] = await db.select({ value: count() }).from(medicalAttachmentsTable).where(attachmentFilter);
    result.push({
      id: request.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      reason: request.reason,
      requestedAt: request.requestedAt.toISOString(),
      recordCount: records?.value ?? 0,
      attachmentCount: attachments?.value ?? 0,
    });
  }
  res.json(GetAdminDeletionRequestsResponse.parse(result));
});

/** Removes sign-in and contact details, revokes all access, and keeps medical records. */
async function closeAccount(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], user: typeof usersTable.$inferSelect) {
  const now = new Date();
  await tx
    .update(usersTable)
    .set({
      isActive: false,
      closedAt: now,
      email: `closed-${user.id}-${randomBytes(6).toString("hex")}@account-closed.invalid`,
      authUserId: null,
      passwordHash: null,
      contactInfo: null,
      nationalIdNumber: null,
      locationRegion: null,
      locationArrondissement: null,
      updatedAt: now,
    })
    .where(eq(usersTable.id, user.id));
  await tx
    .update(accessPermissionsTable)
    .set({ granted: false, expiresAt: now })
    .where(or(eq(accessPermissionsTable.patientId, user.id), eq(accessPermissionsTable.doctorId, user.id)));
  await tx
    .update(accessRequestsTable)
    .set({ status: "EXPIRED", resolvedAt: now })
    .where(and(
      or(eq(accessRequestsTable.patientId, user.id), eq(accessRequestsTable.doctorId, user.id)),
      eq(accessRequestsTable.status, "PENDING"),
    ));
  await tx.delete(notificationsTable).where(eq(notificationsTable.recipientId, user.id));
  await tx.delete(passwordResetRequestsTable).where(eq(passwordResetRequestsTable.email, user.email));
}

router.post("/admin/deletion-requests/:requestId/resolve", requireAuth("ADMIN"), async (req, res): Promise<void> => {
  const params = ResolveAdminDeletionRequestParams.safeParse(req.params);
  const body = ResolveAdminDeletionRequestBody.safeParse(req.body);
  if (!params.success || !body.success) {
    invalidBody(res, "Choose erase, close or reject.");
    return;
  }
  const { action } = body.data;
  const note = body.data.note?.trim() || null;
  if (action === "REJECT" && !note) {
    invalidBody(res, "Explain why the request is rejected; the account holder will see this note.");
    return;
  }
  const [request] = await db
    .select()
    .from(accountDeletionRequestsTable)
    .where(and(eq(accountDeletionRequestsTable.id, params.data.requestId), eq(accountDeletionRequestsTable.status, "PENDING")))
    .limit(1);
  const [user] = request ? await db.select().from(usersTable).where(eq(usersTable.id, request.userId)).limit(1) : [];
  if (!request || !user) {
    res.status(404).json({ error: "This request is no longer waiting for a decision." });
    return;
  }
  if (action === "ERASE" && user.role !== "PATIENT") {
    invalidBody(res, "Doctor accounts can only be closed: the records they wrote belong to their patients' files.");
    return;
  }
  const adminId = req.currentUser!.id;

  // Delete stored files before the database rows that point to them, so a storage failure loses nothing.
  if (action === "ERASE") {
    const attachments = await db
      .select({ objectPath: medicalAttachmentsTable.objectPath })
      .from(medicalAttachmentsTable)
      .where(eq(medicalAttachmentsTable.patientId, user.id));
    try {
      await deleteStoredFiles(attachments.map(({ objectPath }) => objectPath));
    } catch (error) {
      req.log.error({ err: error }, "Could not delete stored attachments before erasing an account");
      res.status(503).json({ error: "Attached files could not be deleted from storage, so nothing was erased. Try again later." });
      return;
    }
  }
  // Erasing or closing removes the sign-in first, so the account cannot be used while the rest is done.
  if (action !== "REJECT" && user.authUserId) {
    try {
      await deleteAuthUser(user.authUserId);
    } catch (error) {
      req.log.error({ err: error }, "Could not delete the sign-in before closing an account");
      res.status(503).json({ error: "The sign-in could not be removed, so nothing was changed. Try again later." });
      return;
    }
  }

  const resolved = await db.transaction(async (tx) => {
    const now = new Date();
    const status = action === "REJECT" ? "REJECTED" : "COMPLETED";
    const outcome = action === "ERASE" ? "ERASED" : action === "CLOSE" ? "CLOSED" : null;
    const [row] = await tx
      .update(accountDeletionRequestsTable)
      .set({ status, outcome, resolutionNote: note, resolvedAt: now, resolvedBy: adminId })
      .where(and(eq(accountDeletionRequestsTable.id, request.id), eq(accountDeletionRequestsTable.status, "PENDING")))
      .returning();
    if (!row) return null;

    if (action === "REJECT") {
      await tx.insert(notificationsTable).values({
        batchId: randomUUID(),
        senderId: adminId,
        recipientId: user.id,
        ...notificationMessages.deletionRejected(languageOf(user.preferredLanguage), note!),
      });
    } else if (action === "CLOSE") {
      await closeAccount(tx, user);
    } else {
      // The patient's own actions (approvals, settings, exports) go with the account. Doctors' access
      // events stay in the audit log with the patient reference removed (ON DELETE SET NULL).
      await tx.delete(auditEventsTable).where(eq(auditEventsTable.actorUserId, user.id));
      await tx.delete(passwordResetRequestsTable).where(eq(passwordResetRequestsTable.email, user.email));
      await tx.delete(usersTable).where(eq(usersTable.id, user.id));
    }
    await tx.insert(auditEventsTable).values({
      actorUserId: adminId,
      patientId: action === "ERASE" || user.role !== "PATIENT" ? null : user.id,
      action: action === "REJECT" ? "ACCOUNT_DELETION_REJECTED" : action === "CLOSE" ? "ACCOUNT_CLOSED" : "ACCOUNT_ERASED",
      entityType: "account_deletion_request",
      entityId: request.id,
    });
    return row;
  });
  if (!resolved) {
    res.status(404).json({ error: "This request is no longer waiting for a decision." });
    return;
  }
  if (action !== "REJECT") {
    await recordSecurityEvent({
      type: action === "ERASE" ? "ACCOUNT_ERASED" : "ACCOUNT_CLOSED",
      severity: action === "ERASE" ? "warning" : "info",
      userId: req.currentUser!.id,
      // Erasure must not leave the person's name behind, so only the role and request number are kept.
      details: action === "ERASE"
        ? { adminName: req.currentUser!.name, role: user.role, deletionRequestId: request.id }
        : { adminName: req.currentUser!.name, accountName: user.name, role: user.role, deletionRequestId: request.id },
      subject: String(user.id),
      actingAdminId: req.currentUser!.id,
    });
  }
  res.json(ResolveAdminDeletionRequestResponse.parse(deletionResponse(resolved)));
});

export default router;
