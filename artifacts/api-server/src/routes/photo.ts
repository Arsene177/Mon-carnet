// The patient's photo for their medical card. Only the patient can add, see or remove it. The web
// app shrinks the picture and removes its metadata (such as location) before sending it.
import { randomUUID } from "node:crypto";
import express, { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { auditEventsTable, db, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/medichain-auth";
import { deletePhotos, photoContentType as imageType, readPhoto, writePhoto } from "../lib/object-storage";

const router: IRouter = Router();
const MAX_BYTES = 2 * 1024 * 1024;

async function currentPhoto(userId: number) {
  const [row] = await db.select({ name: usersTable.photoObjectName }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return row?.name ?? null;
}

router.put(
  "/patient/photo",
  requireAuth("PATIENT"),
  express.raw({ type: ["image/png", "image/jpeg"], limit: MAX_BYTES }),
  async (req, res): Promise<void> => {
    const data = Buffer.isBuffer(req.body) ? req.body : null;
    const type = data ? imageType(data) : null;
    if (!data || !type) {
      res.status(400).json({ error: "Choose a JPEG or PNG photo of at most 2 MB." });
      return;
    }
    const patientId = req.currentUser!.id;
    const previous = await currentPhoto(patientId);
    const name = `photos/${randomUUID()}`;
    await writePhoto(name, data, type);
    await db.transaction(async (tx) => {
      await tx.update(usersTable).set({ photoObjectName: name, updatedAt: new Date() }).where(eq(usersTable.id, patientId));
      await tx.insert(auditEventsTable).values({ actorUserId: patientId, patientId, action: "PATIENT_PHOTO_UPDATED", entityType: "patient_photo" });
    });
    if (previous) await deletePhotos([previous]).catch((err) => req.log.warn({ err }, "Could not delete the previous photo"));
    res.status(204).send();
  },
);

router.get("/patient/photo", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const name = await currentPhoto(req.currentUser!.id);
  if (!name) {
    res.status(404).json({ error: "No photo yet." });
    return;
  }
  const data = await readPhoto(name);
  res.set({ "Content-Type": imageType(data) ?? "application/octet-stream", "Cache-Control": "private, no-store" }).send(data);
});

router.delete("/patient/photo", requireAuth("PATIENT"), async (req, res): Promise<void> => {
  const patientId = req.currentUser!.id;
  const name = await currentPhoto(patientId);
  if (name) {
    await deletePhotos([name]);
    await db.transaction(async (tx) => {
      await tx.update(usersTable).set({ photoObjectName: null, updatedAt: new Date() }).where(eq(usersTable.id, patientId));
      await tx.insert(auditEventsTable).values({ actorUserId: patientId, patientId, action: "PATIENT_PHOTO_REMOVED", entityType: "patient_photo" });
    });
  }
  res.status(204).send();
});

export default router;
