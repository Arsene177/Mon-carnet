import { sql } from "drizzle-orm";
import {
  accessPermissionsTable,
  auditEventsTable,
  db,
  emergencyInfoTable,
  medicalAttachmentsTable,
  medicalDiagnosesTable,
  medicalRecordsTable,
  patientSearchesTable,
  usersTable,
} from "@workspace/db";
import { deleteStoredFiles } from "./lib/object-storage";
import { createAuthUser, deleteAuthUser } from "./lib/supabase";
import { logger } from "./lib/logger";

const adminEmail = "arsenedjonkoun5@gmail.com";
const adminName = "Arsene Djonkoun";

async function resetUsers() {
  if (process.env.RESET_ALL_USERS !== "DELETE_ALL_USERS") {
    throw new Error("Set RESET_ALL_USERS=DELETE_ALL_USERS to confirm the destructive reset.");
  }
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 8 || adminPassword.length > 128) {
    throw new Error("Set ADMIN_PASSWORD to the initial admin password (8-128 characters).");
  }

  const attachments = await db
    .select({ objectPath: medicalAttachmentsTable.objectPath })
    .from(medicalAttachmentsTable);
  await deleteStoredFiles(attachments.map((attachment) => attachment.objectPath));
  // Sign-ins of every account go too, so the emails can be registered again.
  const signIns = await db.select({ authUserId: usersTable.authUserId }).from(usersTable);
  for (const { authUserId } of signIns) if (authUserId) await deleteAuthUser(authUserId);

  const admin = await db.transaction(async (tx) => {
    await tx.delete(auditEventsTable);
    await tx.delete(medicalDiagnosesTable);
    await tx.delete(medicalAttachmentsTable);
    await tx.delete(accessPermissionsTable);
    await tx.delete(patientSearchesTable);
    await tx.delete(emergencyInfoTable);
    await tx.delete(medicalRecordsTable);
    await tx.delete(usersTable);
    const authUserId = await createAuthUser(adminEmail, adminPassword);
    const result = await tx.execute(sql`
      INSERT INTO medichain_users (email, auth_user_id, role, name, is_active)
      VALUES (${adminEmail}, ${authUserId}::uuid, 'ADMIN', ${adminName}, true)
      RETURNING id
    `);
    return result.rows[0];
  });

  if (!admin) throw new Error("The administrator account was not created.");
  logger.info(
    { adminEmail, deletedUserCount: "all existing user accounts", deletedAttachmentCount: attachments.length },
    "Medichain user reset completed; only the requested admin account remains",
  );
}

resetUsers()
  .catch((error: unknown) => {
    logger.error({ error }, "Unable to reset Medichain users");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
