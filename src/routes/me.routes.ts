import { Router } from "express";

import { deleteAccount, getMe } from "../controllers/me.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate } from "../middleware/auth";

export const meRouter = Router();

meRouter.get("/", asyncHandler(authenticate), asyncHandler(getMe));
meRouter.delete("/", asyncHandler(authenticate), asyncHandler(deleteAccount));
