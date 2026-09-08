import sharp from "sharp";

/** Long edge Claude recommends for vision; plenty to read case labels. */
const MAX_EDGE_PX = 1280;
const JPEG_QUALITY = 70;

/**
 * Shrinks a photo for Claude vision. Originals stay in storage; this copy
 * exists only to keep a 21-photo delivery under Anthropic's 32MB request cap.
 */
export async function compressImageForVision(file: {
  buffer: Buffer;
  mimetype: string;
}): Promise<{ buffer: Buffer; mimetype: "image/jpeg" }> {
  const buffer = await sharp(file.buffer)
    .rotate()
    .resize(MAX_EDGE_PX, MAX_EDGE_PX, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  return { buffer, mimetype: "image/jpeg" };
}
