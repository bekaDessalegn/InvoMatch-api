import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";

export const PLANS = {
  starter: { name: "Starter", scans: 90, amountCents: 4900 },
  standard: { name: "Standard", scans: 160, amountCents: 6400 },
  plus: { name: "Plus", scans: 250, amountCents: 7900 },
} as const;

export const TOPUPS = {
  scan_1: { scans: 1, amountCents: 500 },
  scan_5: { scans: 5, amountCents: 1500 },
  scan_10: { scans: 10, amountCents: 2500 },
} as const;

export type PlanId = keyof typeof PLANS;
export type TopupId = keyof typeof TOPUPS;

const GRACE_DAYS = 14;
const TOPUP_DAYS = 90;

export type ScanHold = { skipped: true } | { skipped: false; lotId: string };

export type SubscriptionOverride = "on" | "off" | null;

interface StoreBillingRow {
  id: string;
  name: string;
  subscription_status: string;
  subscription_plan: string | null;
  grace_until: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_override: SubscriptionOverride;
}

/** A store follows the platform switch unless an admin set it on or off. */
export function subscriptionEnforced(platformOn: boolean, override: SubscriptionOverride): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  return platformOn;
}

export function isPlanId(value: string): value is PlanId {
  return value in PLANS;
}

export function isTopupId(value: string): value is TopupId {
  return value in TOPUPS;
}

export async function getSettings(): Promise<{ subscription_mode: boolean }> {
  const { data, error } = await supabase.from("platform_settings").select("subscription_mode").eq("id", 1).single();
  if (error) throw new ApiError(500, error.message);
  return { subscription_mode: Boolean(data.subscription_mode) };
}

export async function setSubscriptionMode(enabled: boolean): Promise<{ subscription_mode: boolean }> {
  const { error } = await supabase
    .from("platform_settings")
    .update({ subscription_mode: enabled, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new ApiError(500, error.message);

  if (enabled) {
    const graceUntil = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error: graceError } = await supabase
      .from("stores")
      .update({ grace_until: graceUntil })
      .is("grace_until", null)
      .neq("subscription_status", "active");
    if (graceError) throw new ApiError(500, graceError.message);
  }

  return { subscription_mode: enabled };
}

async function loadStore(storeId: string): Promise<StoreBillingRow> {
  const { data, error } = await supabase
    .from("stores")
    .select("id, name, subscription_status, subscription_plan, grace_until, stripe_customer_id, stripe_subscription_id, subscription_override")
    .eq("id", storeId)
    .single();
  if (error) throw new ApiError(500, error.message);
  const row = data as StoreBillingRow;
  row.subscription_override = row.subscription_override === "on" || row.subscription_override === "off" ? row.subscription_override : null;
  return row;
}

function inGrace(store: StoreBillingRow): boolean {
  return !!store.grace_until && new Date(store.grace_until).getTime() > Date.now();
}

function isPaying(store: StoreBillingRow): boolean {
  return store.subscription_status === "active" && !!store.subscription_plan;
}

export async function scanBalances(storeId: string): Promise<{ plan: number; topup: number }> {
  const { data, error } = await supabase
    .from("scan_lots")
    .select("source, scans_remaining, expires_at")
    .eq("store_id", storeId);
  if (error) throw new ApiError(500, error.message);

  const now = Date.now();
  let plan = 0;
  let topup = 0;
  for (const lot of data ?? []) {
    if (lot.scans_remaining <= 0) continue;
    if (lot.expires_at && new Date(lot.expires_at as string).getTime() <= now) continue;
    if (lot.source === "plan") plan += lot.scans_remaining as number;
    else topup += lot.scans_remaining as number;
  }
  return { plan, topup };
}

export async function billingSnapshot(storeId: string) {
  const [settings, store, balances] = await Promise.all([getSettings(), loadStore(storeId), scanBalances(storeId)]);
  return {
    subscription_mode: subscriptionEnforced(settings.subscription_mode, store.subscription_override),
    plan: store.subscription_plan,
    status: store.subscription_status,
    grace_until: store.grace_until,
    in_grace: inGrace(store) && !isPaying(store),
    plan_scans_remaining: balances.plan,
    topup_scans_remaining: balances.topup,
    scans_remaining: balances.plan + balances.topup,
    plans: PLANS,
    topups: TOPUPS,
  };
}

/**
 * Call before a Claude scan. When this store is not required to subscribe,
 * or it is inside the grace window and has not subscribed, nothing is reserved.
 * A reserved scan must be refunded if the scan fails.
 */
export async function beginScan(storeId: string): Promise<ScanHold> {
  const [settings, store] = await Promise.all([getSettings(), loadStore(storeId)]);
  if (!subscriptionEnforced(settings.subscription_mode, store.subscription_override)) return { skipped: true };

  if (!isPaying(store)) {
    if (inGrace(store)) return { skipped: true };
    throw new ApiError(
      402,
      "This store needs a plan before it can scan invoices or check deliveries.",
      undefined,
      "subscription_required",
    );
  }

  const { data, error } = await supabase.rpc("consume_scan", { target_store: storeId });
  if (error) throw new ApiError(500, error.message);
  if (!data) {
    throw new ApiError(
      402,
      "This store is out of scans. The owner can buy more or move to a larger plan.",
      undefined,
      "scans_exhausted",
    );
  }
  return { skipped: false, lotId: data as string };
}

export async function refundScan(hold: ScanHold): Promise<void> {
  if (hold.skipped) return;
  const { error } = await supabase.rpc("refund_scan", { lot: hold.lotId });
  if (error) console.error("Failed to refund scan", error.message);
}

export async function grantScans(input: {
  storeId: string;
  source: "plan" | "topup" | "adjustment";
  scans: number;
  expiresAt: string | null;
  stripeId?: string | null;
  reason: string;
  note?: string | null;
}): Promise<boolean> {
  if (input.stripeId) {
    const { data: existing, error: existingError } = await supabase
      .from("scan_lots")
      .select("id")
      .eq("stripe_id", input.stripeId)
      .maybeSingle();
    if (existingError) throw new ApiError(500, existingError.message);
    if (existing) return false;
  }

  const { error } = await supabase.from("scan_lots").insert({
    store_id: input.storeId,
    source: input.source,
    scans_granted: input.scans,
    scans_remaining: input.scans,
    expires_at: input.expiresAt,
    stripe_id: input.stripeId ?? null,
  });
  if (error) {
    if (error.code === "23505") return false;
    throw new ApiError(500, error.message);
  }

  const { error: ledgerError } = await supabase.from("scan_ledger").insert({
    store_id: input.storeId,
    delta: input.scans,
    reason: input.reason,
    note: input.note ?? null,
  });
  if (ledgerError) throw new ApiError(500, ledgerError.message);
  return true;
}

export async function replacePlanScans(storeId: string, plan: PlanId, periodEnd: string | null, stripeId: string): Promise<void> {
  const created = await grantScans({
    storeId,
    source: "plan",
    scans: PLANS[plan].scans,
    expiresAt: periodEnd,
    stripeId,
    reason: "plan_grant",
    note: PLANS[plan].name,
  });
  // The checkout page and the webhook can both report the same payment.
  // A repeat must leave the scans that were already granted.
  if (!created) return;

  const { error } = await supabase
    .from("scan_lots")
    .update({ scans_remaining: 0 })
    .eq("store_id", storeId)
    .eq("source", "plan")
    .gt("scans_remaining", 0)
    .neq("stripe_id", stripeId);
  if (error) throw new ApiError(500, error.message);
}

export async function grantTopup(storeId: string, topup: TopupId, stripeId: string): Promise<void> {
  const expires = new Date(Date.now() + TOPUP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await grantScans({
    storeId,
    source: "topup",
    scans: TOPUPS[topup].scans,
    expiresAt: expires,
    stripeId,
    reason: "topup",
    note: `${TOPUPS[topup].scans} scans`,
  });
}

export async function adjustScans(storeId: string, delta: number, note: string): Promise<void> {
  if (delta > 0) {
    await grantScans({
      storeId,
      source: "adjustment",
      scans: delta,
      expiresAt: null,
      reason: "adjustment",
      note,
    });
    return;
  }

  let left = Math.abs(delta);
  const { data: lots, error: lotsError } = await supabase
    .from("scan_lots")
    .select("id, scans_remaining, expires_at, source")
    .eq("store_id", storeId)
    .gt("scans_remaining", 0);
  if (lotsError) throw new ApiError(500, lotsError.message);

  const now = Date.now();
  const usable = (lots ?? [])
    .filter((lot) => !lot.expires_at || new Date(lot.expires_at as string).getTime() > now)
    .sort((a, b) => (a.source === "plan" ? -1 : 1) - (b.source === "plan" ? -1 : 1));

  for (const lot of usable) {
    if (left <= 0) break;
    const take = Math.min(left, lot.scans_remaining as number);
    const { error } = await supabase
      .from("scan_lots")
      .update({ scans_remaining: (lot.scans_remaining as number) - take })
      .eq("id", lot.id as string);
    if (error) throw new ApiError(500, error.message);
    left -= take;
  }

  const removed = Math.abs(delta) - left;
  const { error } = await supabase.from("scan_ledger").insert({
    store_id: storeId,
    delta: -removed,
    reason: "adjustment",
    note,
  });
  if (error) throw new ApiError(500, error.message);
}

export async function markSubscribed(input: {
  storeId: string;
  plan: PlanId;
  customerId: string | null;
  subscriptionId: string | null;
}): Promise<void> {
  const { error } = await supabase
    .from("stores")
    .update({
      subscription_status: "active",
      subscription_plan: input.plan,
      stripe_customer_id: input.customerId,
      stripe_subscription_id: input.subscriptionId,
    })
    .eq("id", input.storeId);
  if (error) throw new ApiError(500, error.message);
}

export async function setStoreSubscriptionOverride(
  storeId: string,
  override: SubscriptionOverride,
): Promise<{ subscription_override: SubscriptionOverride; grace_until: string | null; subscription_enforced: boolean }> {
  const [settings, store] = await Promise.all([getSettings(), loadStore(storeId)]);
  const patch: { subscription_override: SubscriptionOverride; grace_until?: string } = { subscription_override: override };
  if (override === "on" && !store.grace_until && !isPaying(store)) {
    patch.grace_until = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  }
  const { error } = await supabase.from("stores").update(patch).eq("id", storeId);
  if (error) throw new ApiError(500, error.message);
  const updated = await loadStore(storeId);
  return {
    subscription_override: updated.subscription_override,
    grace_until: updated.grace_until,
    subscription_enforced: subscriptionEnforced(settings.subscription_mode, updated.subscription_override),
  };
}

export async function markCanceled(storeId: string): Promise<void> {
  const { error } = await supabase
    .from("stores")
    .update({ subscription_status: "canceled", stripe_subscription_id: null })
    .eq("id", storeId);
  if (error) throw new ApiError(500, error.message);
}

export { loadStore };
