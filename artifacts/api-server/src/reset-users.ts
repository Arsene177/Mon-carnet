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
import { hashPassword } from "./lib/medichain-auth";
import { logger } from "./lib/logger";

const adminEmail = "arsenedjonkoun5@gmail.com";
const adminName = "Arsene Djonkoun";

function privateObjectPathParts(objectPath: string) {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir || !objectPath.startsWith("/objects/uploads/")) {
    throw new Error("Private object storage is not configured for attachment cleanup.");
  }
  const pathParts = privateDir.replace(/^\/+/, "").split("/");
  const bucketName = pathParts.shift();
  if (!bucketName) throw new Error("Private object storage is not configured for attachment cleanup.");
  return {
    bucketName,
    objectName: [...pathParts, objectPath.slice("/objects/".length)].join("/"),
  };
}

async function deleteStoredAttachment(objectPath: string) {
  const { bucketName, objectName } = privateObjectPathParts(objectPath);
  const signedUrlResponse = await fetch("http://127.0.0.1:1106/object-storage/signed-object-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method: "DELETE",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!signedUrlResponse.ok) {
    throw new Error(`Could not prepare attachment cleanup for ${objectPath}.`);
  }
  const signedUrlResult = await signedUrlResponse.json() as { signed_url?: string };
  if (!signedUrlResult.signed_url) {
    throw new Error("Object storage did not provide an attachment cleanup URL.");
  }
  const deleteResponse = await fetch(signedUrlResult.signed_url, {
    method: "DELETE",
    signal: AbortSignal.timeout(30_000),
  });
  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    throw new Error(`Could not delete stored attachment ${objectPath}.`);
  }
}

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
  for (const attachment of attachments) {
    await deleteStoredAttachment(attachment.objectPath);
  }

  const admin = await db.transaction(async (tx) => {
    await tx.delete(auditEventsTable);
    await tx.delete(medicalDiagnosesTable);
    await tx.delete(medicalAttachmentsTable);
    await tx.delete(accessPermissionsTable);
    await tx.delete(patientSearchesTable);
    await tx.delete(emergencyInfoTable);
    await tx.delete(medicalRecordsTable);
    await tx.delete(usersTable);
    const result = await tx.execute(sql`
      INSERT INTO medichain_users (email, password_hash, role, name, is_active)
      VALUES (${adminEmail}, ${hashPassword(adminPassword)}, 'ADMIN', ${adminName}, true)
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
