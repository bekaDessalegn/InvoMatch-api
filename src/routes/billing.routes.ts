import { Router } from "express";

import { getBilling, postCheckout, postPortal } from "../controllers/billing.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate, requireStore } from "../middleware/auth";

export const billingRouter = Router();

billingRouter.use(asyncHandler(authenticate), asyncHandler(requireStore));
billingRouter.get("/", asyncHandler(getBilling));
billingRouter.post("/checkout", asyncHandler(postCheckout));
billingRouter.post("/portal", asyncHandler(postPortal));
