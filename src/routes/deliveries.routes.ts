import { Router } from "express";

import { analyzeDelivery } from "../controllers/aiParsing.controller";
import {
  createDelivery,
  deleteDelivery,
  getDelivery,
  listDeliveries,
  updateDelivery,
  upsertDeliveryLineItems,
} from "../controllers/deliveries.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate, requireStore } from "../middleware/auth";
import { uploadMultiple } from "../middleware/upload";

export const deliveriesRouter = Router();

deliveriesRouter.use(asyncHandler(authenticate), asyncHandler(requireStore));

deliveriesRouter.get("/", asyncHandler(listDeliveries));
deliveriesRouter.get("/:id", asyncHandler(getDelivery));
deliveriesRouter.post("/", asyncHandler(createDelivery));
deliveriesRouter.patch("/:id", asyncHandler(updateDelivery));
deliveriesRouter.delete("/:id", asyncHandler(deleteDelivery));
deliveriesRouter.put("/:id/line-items", asyncHandler(upsertDeliveryLineItems));

// AI-powered: accepts one or more delivery photos and returns detected item counts/matches.
deliveriesRouter.post("/analyze", uploadMultiple, asyncHandler(analyzeDelivery));
