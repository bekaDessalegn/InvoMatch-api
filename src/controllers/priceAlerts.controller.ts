import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import { creatorScope, ownedInvoiceIds } from "../utils/access";

interface PriceHistoryRow {
  item_id: string;
  vendor_id: string;
  invoice_id: string;
  price: number;
  recorded_at: string;
  items: { canonical_name: string } | null;
  vendors: { name: string } | null;
  invoices: { invoice_number: string } | null;
}

interface VendorItemRow {
  item_id: string;
  vendor_id: string;
  vendor_sku: string | null;
}

/**
 * GET /price-alerts
 *
 * There's no dedicated `price_alerts` table — an alert is simply "the two
 * most recent price_history rows for the same catalog item disagree",
 * even when those prices came from different suppliers. This computes
 * that on the fly from price_history, which stays cheap since per-store
 * history sizes are small.
 */
export async function listPriceAlerts(req: Request, res: Response) {
  const storeId = req.storeId!;
  const ownerId = creatorScope(req);
  const invoiceIds = ownerId ? await ownedInvoiceIds(storeId, ownerId) : undefined;
  if (invoiceIds && invoiceIds.length === 0) {
    res.json({ data: [] });
    return;
  }

  let historyQuery = supabase
    .from("price_history")
    .select("item_id, vendor_id, invoice_id, price, recorded_at, items(canonical_name), vendors(name), invoices(invoice_number)")
    .eq("store_id", storeId)
    .order("recorded_at", { ascending: false });
  if (invoiceIds) historyQuery = historyQuery.in("invoice_id", invoiceIds);

  const [
    { data: history, error: historyError },
    { data: vendorItems, error: viError },
    { data: dismissals, error: dismissalError },
    { data: store, error: storeError },
  ] = await Promise.all([
    historyQuery,
    supabase.from("vendor_items").select("item_id, vendor_id, vendor_sku").eq("store_id", storeId),
    supabase
      .from("price_alert_dismissals")
      .select("item_id, vendor_id, invoice_id")
      .eq("store_id", storeId)
      .eq("dismissed_by", req.userId!),
    supabase.from("stores").select("target_margin_percent").eq("id", storeId).single(),
  ]);

  if (historyError) throw new ApiError(500, historyError.message);
  if (viError) throw new ApiError(500, viError.message);
  if (dismissalError) throw new ApiError(500, dismissalError.message);
  if (storeError) throw new ApiError(500, storeError.message);
  const margin = store.target_margin_percent == null ? null : Number(store.target_margin_percent);

  const skuByItemVendor = new Map<string, string | null>();
  for (const vi of (vendorItems ?? []) as VendorItemRow[]) {
    skuByItemVendor.set(`${vi.item_id}:${vi.vendor_id}`, vi.vendor_sku);
  }

  // Dismissals are keyed by the specific invoice that triggered the alert,
  // so acknowledging a change doesn't silence a later price change on the
  // same item.
  const dismissedTriggers = new Set(
    (dismissals ?? []).map((d) => `${d.item_id}:${d.vendor_id}:${d.invoice_id}`)
  );

  // Multiple line items on the same invoice can share a canonical item
  // name (e.g. the same product listed at several quantity-break prices)
  // and each write their own price_history row. Collapse those down to one
  // row per invoice per item so a "price change" alert only ever fires
  // between two different invoices — never between two lines of the same
  // one, and regardless of which supplier each invoice came from.
  const byItem = new Map<string, PriceHistoryRow[]>();
  const seenInvoicesByItem = new Map<string, Set<string>>();
  for (const row of (history ?? []) as unknown as PriceHistoryRow[]) {
    const seenInvoices = seenInvoicesByItem.get(row.item_id) ?? new Set<string>();
    if (seenInvoices.has(row.invoice_id)) continue;
    seenInvoices.add(row.invoice_id);
    seenInvoicesByItem.set(row.item_id, seenInvoices);

    const rows = byItem.get(row.item_id) ?? [];
    rows.push(row); // already sorted most-recent-first, now one row per invoice
    byItem.set(row.item_id, rows);
  }

  const alerts = [];
  for (const rows of byItem.values()) {
    if (rows.length < 2) continue;
    const [latest, previous, earlier] = rows as [PriceHistoryRow, PriceHistoryRow, PriceHistoryRow?];
    if (Number(latest.price) === Number(previous.price)) continue;
    if (dismissedTriggers.has(`${latest.item_id}:${latest.vendor_id}:${latest.invoice_id}`)) continue;

    alerts.push({
      item_id: latest.item_id,
      item_name: latest.items?.canonical_name ?? "Unknown item",
      sku: skuByItemVendor.get(`${latest.item_id}:${latest.vendor_id}`) ?? null,
      vendor_id: latest.vendor_id,
      vendor_name: latest.vendors?.name ?? "Unknown vendor",
      previous_vendor_name: previous.vendors?.name ?? "Unknown vendor",
      earlier_price: earlier ? Number(earlier.price) : null,
      previous_price: Number(previous.price),
      new_price: Number(latest.price),
      suggested_price: suggestedShelfPrice(Number(latest.price), margin),
      source_invoice_id: latest.invoice_id,
      source_invoice_number: latest.invoices?.invoice_number ?? null,
      changed_at: latest.recorded_at,
    });
  }

  alerts.sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());
  res.json({ data: alerts });
}

/** Shelf price that keeps [marginPercent] of the selling price as profit. */
function suggestedShelfPrice(cost: number, marginPercent: number | null): number | null {
  if (marginPercent == null || !(marginPercent > 0) || !(marginPercent < 100) || !(cost >= 0)) return null;
  return Math.round((cost / (1 - marginPercent / 100)) * 100) / 100;
}

const dismissPriceAlertSchema = z.object({
  item_id: z.string().uuid(),
  vendor_id: z.string().uuid(),
  source_invoice_id: z.string().uuid(),
});

/**
 * POST /price-alerts/dismiss
 *
 * Records that the store has seen this specific price change so it stops
 * showing up in the list. Scoped to the triggering invoice, so a later
 * price change on a newer invoice still surfaces as a fresh alert.
 */
export async function dismissPriceAlert(req: Request, res: Response) {
  const parsed = dismissPriceAlertSchema.safeParse(req.body);
  if (parsed.success === false) throw new ApiError(400, "Invalid dismiss payload", parsed.error.flatten());

  const ownerId = creatorScope(req);
  if (ownerId) {
    const invoiceIds = await ownedInvoiceIds(req.storeId!, ownerId);
    if (!invoiceIds.includes(parsed.data.source_invoice_id)) {
      throw new ApiError(404, "Price alert not found");
    }
  }

  const { error } = await supabase.from("price_alert_dismissals").upsert(
    {
      store_id: req.storeId!,
      dismissed_by: req.userId!,
      item_id: parsed.data.item_id,
      vendor_id: parsed.data.vendor_id,
      invoice_id: parsed.data.source_invoice_id,
    },
    { onConflict: "store_id,dismissed_by,item_id,vendor_id,invoice_id", ignoreDuplicates: true }
  );

  if (error) throw new ApiError(500, error.message);
  res.status(204).send();
}
