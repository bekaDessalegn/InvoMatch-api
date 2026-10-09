import type { Request, Response } from "express";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import { billingSnapshot } from "../services/billing";
import { applyListedPrices, stripeReady } from "../services/stripeBilling";

/**
 * GET /api/me
 *
 * Returns the authenticated user plus their store membership, if any. The
 * Flutter app calls this right after sign-in/sign-up to decide whether to
 * show the main app or the Create Store flow.
 */
export async function getMe(req: Request, res: Response) {
  const { data, error } = await supabase
    .from("store_members")
    .select("role, stores(id, name, subscription_status, subscription_plan, created_at)")
    .eq("user_id", req.userId!)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);

  const store = data?.stores as { id?: string } | null;
  const billing = store?.id
    ? { ...(await applyListedPrices(await billingSnapshot(store.id))), stripe_ready: stripeReady() }
    : null;

  res.json({
    data: {
      user: { id: req.userId, email: req.userEmail },
      store: data ? { ...data.stores, role: data.role } : null,
      billing,
    },
  });
}
