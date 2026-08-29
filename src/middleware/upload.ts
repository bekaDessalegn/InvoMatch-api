import multer from "multer";

/**
 * In-memory upload handler for invoice/delivery photos and PDFs. Files stay
 * in memory just long enough to be forwarded to Claude and/or Supabase
 * Storage — nothing is written to local disk.
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});
