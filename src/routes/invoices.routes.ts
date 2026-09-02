import { Router } from "express";

import { parseInvoice } from "../controllers/aiParsing.controller";
import {
  confirmInvoice,
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  updateInvoice,
} from "../controllers/invoices.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate, requireStore } from "../middleware/auth";
import { uploadMultiple } from "../middleware/upload";

export const invoicesRouter = Router();

invoicesRouter.use(asyncHandler(authenticate), asyncHandler(requireStore));

invoicesRouter.get("/", asyncHandler(listInvoices));
invoicesRouter.get("/:id", asyncHandler(getInvoice));
invoicesRouter.post("/", asyncHandler(createInvoice));
invoicesRouter.patch("/:id", asyncHandler(updateInvoice));
invoicesRouter.delete("/:id", asyncHandler(deleteInvoice));
invoicesRouter.post("/:id/confirm", asyncHandler(confirmInvoice));

// AI-powered: accepts one or more invoice photos (or a single PDF) and
// returns structured line items.
invoicesRouter.post("/parse", uploadMultiple, asyncHandler(parseInvoice));
