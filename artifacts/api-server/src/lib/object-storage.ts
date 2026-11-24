// Private lab files in Supabase Storage. Records keep the path "/objects/uploads/<id>"; the file is
// stored in the private bucket as "uploads/<id>".
import {
  deleteObjects,
  downloadObject,
  objectExists,
  signedDownloadUrl,
  signedUploadUrl,
  uploadObject,
} from "./supabase";

const ATTACHMENT_PATH = /^\/objects\/(uploads\/[0-9a-f-]{36})$/;

/** The object name in the bucket for an attachment path such as "/objects/uploads/<id>". */
export function attachmentObjectName(objectPath: string): string {
  const match = ATTACHMENT_PATH.exec(objectPath);
  if (!match) throw new Error("Not a lab file path.");
  return match[1]!;
}

/** A URL the browser can PUT the file to. */
export const fileUploadUrl = (objectPath: string) => signedUploadUrl(attachmentObjectName(objectPath));

/** A URL the browser can download the file from for `ttlSeconds`. */
export const fileDownloadUrl = (objectPath: string, ttlSeconds: number) => signedDownloadUrl(attachmentObjectName(objectPath), ttlSeconds);

export const storedFileExists = (objectPath: string) => objectExists(attachmentObjectName(objectPath));

/** Deletes files; files that are already gone are ignored. */
export const deleteStoredFiles = (objectPaths: string[]) => deleteObjects(objectPaths.map(attachmentObjectName));

export const readStoredFile = (objectPath: string) => downloadObject(attachmentObjectName(objectPath));

export const writeStoredFile = (objectPath: string, data: Buffer, contentType: string) => uploadObject(attachmentObjectName(objectPath), data, contentType);

// Patients' card photos: "photos/<uuid>" in the same private bucket. Only the API reads them.
const PHOTO_NAME = /^photos\/[0-9a-f-]{36}$/;
const photoName = (name: string) => {
  if (!PHOTO_NAME.test(name)) throw new Error("Not a photo name.");
  return name;
};
/** The image type from a file's first bytes, never from what a browser claims. */
export function photoContentType(data: Buffer): "image/png" | "image/jpeg" | null {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}
export const writePhoto = (name: string, data: Buffer, contentType: string) => uploadObject(photoName(name), data, contentType);
export const readPhoto = (name: string) => downloadObject(photoName(name));
export const deletePhotos = (names: string[]) => deleteObjects(names.map(photoName));
