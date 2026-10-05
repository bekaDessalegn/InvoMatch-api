import { Router } from "express";

import { acceptInvite, pendingInvite } from "../controllers/team.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate } from "../middleware/auth";

export const invitesRouter = Router();

// A signed-in person may not have a store yet — this is how an invite joins one.
invitesRouter.get("/pending", asyncHandler(authenticate), asyncHandler(pendingInvite));
invitesRouter.post("/accept", asyncHandler(authenticate), asyncHandler(acceptInvite));
