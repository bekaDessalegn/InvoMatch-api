import { Router } from "express";

import { createStore } from "../controllers/stores.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate } from "../middleware/auth";

export const storesRouter = Router();

// Deliberately does NOT use requireStore — this is how a user without a
// store yet creates their first one.
storesRouter.post("/", asyncHandler(authenticate), asyncHandler(createStore));
