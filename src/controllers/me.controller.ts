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
    .select("role, stores(id, name, subscription_status, subscription_plan, target_margin_percent, created_at)")
    .eq("user_id", req.userId!)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);

  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("full_name")
    .eq("user_id", req.userId!)
    .maybeSingle();
  if (profileError) throw new ApiError(500, profileError.message);

  const store = data?.stores as { id?: string } | null;
  const billing = store?.id
    ? { ...(await applyListedPrices(await billingSnapshot(store.id))), stripe_ready: stripeReady() }
    : null;

  res.json({
    data: {
      user: { id: req.userId, email: req.userEmail, full_name: profile?.full_name ?? null },
      store: data ? { ...data.stores, role: data.role } : null,
      billing,
    },
  });
}

/**
 * DELETE /api/me
 *
 * Removes the login. Invoices a staff member created stay on the store.
 * The owner can delete the account only when nobody else is on the team;
 * that also deletes the store. A Stripe subscription is not canceled here.
 */
export async function deleteAccount(req: Request, res: Response) {
  const userId = req.userId!;
  const { data: membership, error: memberError } = await supabase
    .from("store_members")
    .select("store_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw new ApiError(500, memberError.message);

  if (membership?.role === "owner") {
    const { count, error: countError } = await supabase
      .from("store_members")
      .select("user_id", { count: "exact", head: true })
      .eq("store_id", membership.store_id);
    if (countError) throw new ApiError(500, countError.message);
    if ((count ?? 0) > 1) {
      throw new ApiError(
        409,
        "Remove everyone else from the team first. The store needs an owner, so this account can't be deleted while other people still have access.",
      );
    }
    const storeId = membership.store_id;
    const { error: invoiceError } = await supabase.from("invoices").delete().eq("store_id", storeId);
    if (invoiceError) throw new ApiError(500, invoiceError.message);
    const { error: vendorError } = await supabase.from("vendors").delete().eq("store_id", storeId);
    if (vendorError) throw new ApiError(500, vendorError.message);
    const { error: storeError } = await supabase.from("stores").delete().eq("id", storeId);
    if (storeError) throw new ApiError(500, storeError.message);
  }

  const { error: inviteError } = await supabase.from("store_invites").delete().eq("invited_by", userId);
  if (inviteError) throw new ApiError(500, inviteError.message);

  const { error: deleteError } = await supabase.auth.admin.deleteUser(userId);
  if (deleteError) throw new ApiError(500, deleteError.message);
  res.status(204).send();
}
