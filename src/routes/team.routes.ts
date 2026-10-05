import { Router } from "express";

import { createInvite, listTeam, removeMember } from "../controllers/team.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate, requireManager, requireStore } from "../middleware/auth";

export const teamRouter = Router();

teamRouter.use(asyncHandler(authenticate), asyncHandler(requireStore), asyncHandler(requireManager));

teamRouter.get("/", asyncHandler(listTeam));
teamRouter.post("/invites", asyncHandler(createInvite));
teamRouter.delete("/members/:userId", asyncHandler(removeMember));
