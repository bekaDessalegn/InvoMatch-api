import { Router } from "express";

import {
  createVendor,
  deleteVendor,
  getVendor,
  listVendors,
  updateVendor,
} from "../controllers/vendors.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate, requireStore } from "../middleware/auth";

export const vendorsRouter = Router();

vendorsRouter.use(asyncHandler(authenticate), asyncHandler(requireStore));

vendorsRouter.get("/", asyncHandler(listVendors));
vendorsRouter.get("/:id", asyncHandler(getVendor));
vendorsRouter.post("/", asyncHandler(createVendor));
vendorsRouter.patch("/:id", asyncHandler(updateVendor));
vendorsRouter.delete("/:id", asyncHandler(deleteVendor));
