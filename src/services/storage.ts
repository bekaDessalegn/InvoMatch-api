import { randomUUID } from "crypto";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — plenty for a single review session.

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/**
 * Uploads a buffer to a private Storage bucket under `${storeId}/${uuid}.ext`
 * and returns the storage path (not a URL — see `signStoragePath`). Every
 * store's files live in their own prefix, though access is enforced by the
 * backend's store-scoping, not Storage RLS (the service-role key bypasses
 * RLS entirely).
 */
export async function uploadToStorage(
  bucket: "invoice-photos" | "delivery-photos",
  storeId: string,
  file: { buffer: Buffer; mimetype: string }
): Promise<string> {
  const extension = EXTENSION_BY_MIME[file.mimetype] ?? "bin";
  const path = `${storeId}/${randomUUID()}.${extension}`;

  const { error } = await supabase.storage.from(bucket).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });

  if (error) throw new ApiError(500, `Failed to store file: ${error.message}`);
  return path;
}

/** Turns a stored path into a short-lived signed URL Flutter can load directly. */
export async function signStoragePath(
  bucket: "invoice-photos" | "delivery-photos",
  path: string | null
): Promise<string | null> {
  if (!path) return null;

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) return null; // Don't fail the whole request over a stale/missing file.
  return data.signedUrl;
}
