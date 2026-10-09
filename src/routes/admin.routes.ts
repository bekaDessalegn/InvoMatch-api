import { Router } from "express";

import {
  getAdminOverview,
  getAdminSettings,
  getAdminStore,
  listAdminStores,
  listAdminUsers,
  patchAdminSettings,
  patchAdminStoreSubscription,
  postAdminScanAdjustment,
} from "../controllers/admin.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate } from "../middleware/auth";
import { requirePlatformAdmin } from "../middleware/platformAdmin";

export const adminRouter = Router();

adminRouter.use(asyncHandler(authenticate), asyncHandler(requirePlatformAdmin));
adminRouter.get("/overview", asyncHandler(getAdminOverview));
adminRouter.get("/settings", asyncHandler(getAdminSettings));
adminRouter.patch("/settings", asyncHandler(patchAdminSettings));
adminRouter.get("/users", asyncHandler(listAdminUsers));
adminRouter.get("/stores", asyncHandler(listAdminStores));
adminRouter.get("/stores/:id", asyncHandler(getAdminStore));
adminRouter.patch("/stores/:id/subscription", asyncHandler(patchAdminStoreSubscription));
adminRouter.post("/stores/:id/scans", asyncHandler(postAdminScanAdjustment));
