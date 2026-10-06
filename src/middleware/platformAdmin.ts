import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env";
import { supabase } from "../db/supabase";
import { ApiError } from "./errorHandler";

/** Platform admins are separate from store owners. Must run after authenticate. */
export async function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) throw new ApiError(401, "Authentication required");

  const email = req.userEmail?.toLowerCase();
  if (email && env.platformAdminEmails.includes(email)) {
    const { error } = await supabase
      .from("platform_admins")
      .upsert({ user_id: req.userId }, { onConflict: "user_id", ignoreDuplicates: true });
    if (error) throw new ApiError(500, error.message);
    next();
    return;
  }

  const { data, error } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", req.userId)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(403, "Only a platform admin can do that.");
  next();
}
