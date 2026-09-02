import multer from "multer";

/**
 * In-memory upload handler for invoice/delivery photos and PDFs. Files stay
 * in memory just long enough to be forwarded to Claude and/or Supabase
 * Storage — nothing is written to local disk.
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

/**
 * Same constraints as `upload`, but accepts up to 10 files under the field
 * name "files" — used by `/invoices/parse` and `/deliveries/analyze` so a
 * long invoice or a big delivery can be captured across several photos.
 */
export const uploadMultiple = upload.array("files", 10);
