import { Router } from "express";

import { createStore, updateStoreMargin } from "../controllers/stores.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate, requireManager, requireStore } from "../middleware/auth";

export const storesRouter = Router();

// Deliberately does NOT use requireStore — this is how a user without a
// store yet creates their first one.
storesRouter.post("/", asyncHandler(authenticate), asyncHandler(createStore));
storesRouter.patch(
  "/margin",
  asyncHandler(authenticate),
  asyncHandler(requireStore),
  asyncHandler(requireManager),
  asyncHandler(updateStoreMargin),
);
