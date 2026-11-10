// Private file storage (Replit Object Storage). The local storage sidecar issues short-lived
// signed URLs; OBJECT_STORAGE_SIDECAR_URL overrides its address (used by the backup tests).
export type SignedUrlMethod = "PUT" | "GET" | "DELETE";

function sidecarUrl(): string {
  return process.env.OBJECT_STORAGE_SIDECAR_URL ?? "http://127.0.0.1:1106";
}

/** Splits PRIVATE_OBJECT_DIR ("/bucket/some/dir") into the bucket and the directory inside it. */
export function privateStorageRoot(): { bucketName: string; directory: string } | null {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) return null;
  const parts = privateDir.replace(/^\/+/, "").split("/").filter(Boolean);
  const bucketName = parts.shift();
  return bucketName ? { bucketName, directory: parts.join("/") } : null;
}

export async function signedStorageUrl(
  bucketName: string,
  objectName: string,
  method: SignedUrlMethod,
  ttlSeconds: number,
): Promise<string> {
  const response = await fetch(`${sidecarUrl()}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Unable to create a private file URL.");
  const result = await response.json() as { signed_url?: string };
  if (!result.signed_url) throw new Error("Storage did not return a signed URL.");
  return result.signed_url;
}

/** Bucket and object name for an attachment path such as "/objects/uploads/<id>". */
export function attachmentObjectName(objectPath: string): { bucketName: string; objectName: string } {
  const root = privateStorageRoot();
  if (!root || !objectPath.startsWith("/objects/uploads/")) {
    throw new Error("Private object storage is not configured.");
  }
  const objectName = [root.directory, objectPath.slice("/objects/".length)].filter(Boolean).join("/");
  return { bucketName: root.bucketName, objectName };
}
