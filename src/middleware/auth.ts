import type { NextFunction, Request, Response } from "express";

import { supabase } from "../db/supabase";
import { ApiError } from "./errorHandler";

/**
 * Verifies the `Authorization: Bearer <token>` header by asking Supabase
 * Auth to validate it, and attaches the authenticated user's id/email to
 * the request. Every route that touches store-scoped data must run this
 * first.
 *
 * Deliberately does NOT verify the JWT signature locally — Supabase
 * projects can sign tokens with either a legacy shared HS256 secret or the
 * newer per-project asymmetric JWT Signing Keys (which rotate over time),
 * and there's no single static secret that's guaranteed to keep working.
 * Delegating to `supabase.auth.getUser()` handles whichever signing
 * method/key is currently active without us having to track it.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new ApiError(401, "Missing or malformed Authorization header");
  }

  const token = header.slice("Bearer ".length).trim();

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, "Invalid or expired session");

  req.userId = data.user.id;
  req.userEmail = data.user.email;
  next();
}

/**
 * Looks up the authenticated user's store membership and attaches
 * storeId/storeRole to the request. Must run after `authenticate`.
 * Routes using this middleware return 403 for authenticated users who
 * haven't created/joined a store yet (they should hit POST /api/stores
 * first, which only requires `authenticate`).
 */
export async function requireStore(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) throw new ApiError(401, "Authentication required");

  const { data, error } = await supabase
    .from("store_members")
    .select("store_id, role")
    .eq("user_id", req.userId)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(403, "You don't belong to a store yet. Create one via POST /api/stores.");

  req.storeId = data.store_id;
  req.storeRole = data.role as "owner" | "keeper";
  next();
}
