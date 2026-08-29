import { Router } from "express";

import { listPriceAlerts } from "../controllers/priceAlerts.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate, requireStore } from "../middleware/auth";

export const priceAlertsRouter = Router();

priceAlertsRouter.use(asyncHandler(authenticate), asyncHandler(requireStore));

priceAlertsRouter.get("/", asyncHandler(listPriceAlerts));
