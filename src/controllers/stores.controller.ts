import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";

const createStoreSchema = z.object({
  name: z.string().min(1, "Store name is required"),
});

/**
 * POST /api/stores
 *
 * Creates a store for the authenticated user and makes them its owner.
 * Requires only `authenticate` (not `requireStore`) since this is exactly
 * how a brand-new user gets their first store. Each user may belong to at
 * most one store today (enforced by a unique index on store_members.user_id
 * as well, as a DB-level backstop against race conditions).
 */
export async function createStore(req: Request, res: Response) {
  const parsed = createStoreSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid store payload", parsed.error.flatten());

  const { data: existingMembership, error: membershipLookupError } = await supabase
    .from("store_members")
    .select("id")
    .eq("user_id", req.userId!)
    .maybeSingle();

  if (membershipLookupError) throw new ApiError(500, membershipLookupError.message);
  if (existingMembership) throw new ApiError(409, "You already belong to a store");

  const { data: store, error: storeError } = await supabase
    .from("stores")
    .insert({ name: parsed.data.name })
    .select("*")
    .single();

  if (storeError) throw new ApiError(500, storeError.message);

  const { error: memberError } = await supabase
    .from("store_members")
    .insert({ store_id: store.id, user_id: req.userId!, role: "owner" });

  if (memberError) {
    // Roll back the orphaned store so a failed signup doesn't leave debris.
    await supabase.from("stores").delete().eq("id", store.id);
    throw new ApiError(500, memberError.message);
  }

  res.status(201).json({ data: { ...store, role: "owner" } });
}
