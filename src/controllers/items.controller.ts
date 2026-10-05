import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import { assertCanEdit, creatorScope, ownedInvoiceIds, visibleItemIds } from "../utils/access";

const createItemSchema = z.object({
  canonical_name: z.string().min(1),
  category: z.string().nullable().optional(),
});

const updateItemSchema = createItemSchema.partial();

interface PriceHistoryRow {
  item_id: string;
  vendor_id: string;
  invoice_id: string;
  price: number;
  recorded_at: string;
  vendors: { name: string } | null;
}

interface VendorItemRow {
  item_id: string;
  vendor_id: string;
  vendor_sku: string | null;
}

/**
 * Computes each item's `current_cost`/`previous_cost` (latest two
 * price_history entries, most recent vendor wins ties), `vendor_name`, and
 * `sku` for display. Aggregated in JS from a couple of store-scoped queries
 * rather than a DB view, since catalog sizes here stay small.
 */
async function attachItemAggregates(
  storeId: string,
  items: Record<string, unknown>[],
  invoiceIds?: string[]
) {
  if (items.length === 0) return items;

  let historyQuery = supabase
    .from("price_history")
    .select("item_id, vendor_id, invoice_id, price, recorded_at, vendors(name)")
    .eq("store_id", storeId)
    .order("recorded_at", { ascending: false });
  if (invoiceIds) {
    if (invoiceIds.length === 0) {
      return items.map((item) => ({
        ...item,
        current_cost: null,
        previous_cost: null,
        vendor_name: null,
        sku: null,
        last_invoice_date: null,
      }));
    }
    historyQuery = historyQuery.in("invoice_id", invoiceIds);
  }

  const [{ data: history, error: historyError }, { data: vendorItems, error: viError }] = await Promise.all([
    historyQuery,
    supabase.from("vendor_items").select("item_id, vendor_id, vendor_sku").eq("store_id", storeId),
  ]);

  if (historyError) throw new ApiError(500, historyError.message);
  if (viError) throw new ApiError(500, viError.message);

  // See the equivalent comment in priceAlerts.controller.ts — collapse
  // multiple lines of the same invoice down to one row per invoice so
  // current/previous cost reflect two different invoices, not two lines of
  // the same one.
  const historyByItem = new Map<string, PriceHistoryRow[]>();
  const seenInvoicesByItem = new Map<string, Set<string>>();
  for (const row of (history ?? []) as unknown as PriceHistoryRow[]) {
    const seenInvoices = seenInvoicesByItem.get(row.item_id) ?? new Set<string>();
    if (seenInvoices.has(row.invoice_id)) continue;
    seenInvoices.add(row.invoice_id);
    seenInvoicesByItem.set(row.item_id, seenInvoices);

    const list = historyByItem.get(row.item_id) ?? [];
    list.push(row);
    historyByItem.set(row.item_id, list);
  }

  const skuByItemVendor = new Map<string, string | null>();
  for (const vi of (vendorItems ?? []) as VendorItemRow[]) {
    skuByItemVendor.set(`${vi.item_id}:${vi.vendor_id}`, vi.vendor_sku);
  }

  return items.map((item) => {
    const rows = historyByItem.get(item.id as string) ?? [];
    const [latest, previous] = rows; // already sorted most-recent-first
    return {
      ...item,
      current_cost: latest ? latest.price : null,
      previous_cost: previous ? previous.price : null,
      vendor_name: latest?.vendors?.name ?? null,
      sku: latest ? skuByItemVendor.get(`${item.id}:${latest.vendor_id}`) ?? null : null,
      last_invoice_date: latest ? latest.recorded_at : null,
    };
  });
}

export async function listItems(req: Request, res: Response) {
  const ownerId = creatorScope(req);
  let query = supabase.from("items").select("*").eq("store_id", req.storeId!).order("canonical_name", { ascending: true });
  if (ownerId) {
    const ids = await visibleItemIds(req.storeId!, ownerId);
    if (ids.length === 0) {
      res.json({ data: [] });
      return;
    }
    query = query.in("id", ids);
  }

  const { data, error } = await query;
  if (error) throw new ApiError(500, error.message);
  const invoiceIds = ownerId ? await ownedInvoiceIds(req.storeId!, ownerId) : undefined;
  res.json({ data: await attachItemAggregates(req.storeId!, data ?? [], invoiceIds) });
}

export async function getItem(req: Request, res: Response) {
  const { data, error } = await supabase
    .from("items")
    .select("*")
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Item not found");
  const ownerId = creatorScope(req);
  if (ownerId && !(await visibleItemIds(req.storeId!, ownerId)).includes(data.id)) {
    throw new ApiError(404, "Item not found");
  }
  const invoiceIds = ownerId ? await ownedInvoiceIds(req.storeId!, ownerId) : undefined;
  const [withAggregates] = await attachItemAggregates(req.storeId!, [data], invoiceIds);
  res.json({ data: withAggregates });
}

export async function getItemPriceHistory(req: Request, res: Response) {
  const itemId = req.params.id as string;
  const ownerId = creatorScope(req);
  if (ownerId && !(await visibleItemIds(req.storeId!, ownerId)).includes(itemId)) {
    throw new ApiError(404, "Item not found");
  }

  let historyQuery = supabase
    .from("price_history")
    .select("price, recorded_at, invoice_id, invoices(invoice_number)")
    .eq("item_id", itemId)
    .eq("store_id", req.storeId!)
    .order("recorded_at", { ascending: true });
  if (ownerId) {
    const invoiceIds = await ownedInvoiceIds(req.storeId!, ownerId);
    if (invoiceIds.length === 0) {
      res.json({ data: [] });
      return;
    }
    historyQuery = historyQuery.in("invoice_id", invoiceIds);
  }

  const { data, error } = await historyQuery;

  if (error) throw new ApiError(500, error.message);

  // Same collapse as attachItemAggregates: one chart point per invoice,
  // not one per matching line item within an invoice.
  const seenInvoices = new Set<string>();
  const deduped = (data ?? []).filter((row) => {
    if (seenInvoices.has(row.invoice_id as string)) return false;
    seenInvoices.add(row.invoice_id as string);
    return true;
  });

  res.json({ data: deduped });
}

export async function createItem(req: Request, res: Response) {
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid item payload", parsed.error.flatten());

  const { data, error } = await supabase
    .from("items")
    .insert({ ...parsed.data, store_id: req.storeId!, created_by: req.userId! })
    .select("*")
    .single();

  if (error) throw new ApiError(500, error.message);
  res.status(201).json({ data });
}

export async function updateItem(req: Request, res: Response) {
  const parsed = updateItemSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid item payload", parsed.error.flatten());

  const { data: existing, error: existingError } = await supabase
    .from("items")
    .select("created_by")
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();
  if (existingError) throw new ApiError(500, existingError.message);
  if (!existing) throw new ApiError(404, "Item not found");
  assertCanEdit(req, existing.created_by);

  const { data, error } = await supabase
    .from("items")
    .update(parsed.data)
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .select("*")
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Item not found");
  res.json({ data });
}

export async function deleteItem(req: Request, res: Response) {
  const { data: existing, error: existingError } = await supabase
    .from("items")
    .select("created_by")
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();
  if (existingError) throw new ApiError(500, existingError.message);
  if (!existing) throw new ApiError(404, "Item not found");
  assertCanEdit(req, existing.created_by);

  const { error } = await supabase.from("items").delete().eq("id", req.params.id).eq("store_id", req.storeId!);

  if (error) throw new ApiError(500, error.message);
  res.status(204).send();
}
