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
