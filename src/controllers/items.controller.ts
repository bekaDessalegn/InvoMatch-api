import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";

const createItemSchema = z.object({
  canonical_name: z.string().min(1),
  category: z.string().nullable().optional(),
});

const updateItemSchema = createItemSchema.partial();

interface PriceHistoryRow {
  item_id: string;
  vendor_id: string;
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
async function attachItemAggregates(storeId: string, items: Record<string, unknown>[]) {
  if (items.length === 0) return items;

  const [{ data: history, error: historyError }, { data: vendorItems, error: viError }] = await Promise.all([
    supabase
      .from("price_history")
      .select("item_id, vendor_id, price, recorded_at, vendors(name)")
      .eq("store_id", storeId)
      .order("recorded_at", { ascending: false }),
    supabase.from("vendor_items").select("item_id, vendor_id, vendor_sku").eq("store_id", storeId),
  ]);

  if (historyError) throw new ApiError(500, historyError.message);
  if (viError) throw new ApiError(500, viError.message);

  const historyByItem = new Map<string, PriceHistoryRow[]>();
  for (const row of (history ?? []) as unknown as PriceHistoryRow[]) {
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
  const { data, error } = await supabase
    .from("items")
    .select("*")
    .eq("store_id", req.storeId!)
    .order("canonical_name", { ascending: true });

  if (error) throw new ApiError(500, error.message);
  res.json({ data: await attachItemAggregates(req.storeId!, data ?? []) });
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
  const [withAggregates] = await attachItemAggregates(req.storeId!, [data]);
  res.json({ data: withAggregates });
}

export async function getItemPriceHistory(req: Request, res: Response) {
  const { data, error } = await supabase
    .from("price_history")
    .select("*")
    .eq("item_id", req.params.id)
    .eq("store_id", req.storeId!)
    .order("recorded_at", { ascending: true });

  if (error) throw new ApiError(500, error.message);
  res.json({ data });
}

export async function createItem(req: Request, res: Response) {
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid item payload", parsed.error.flatten());

  const { data, error } = await supabase
    .from("items")
    .insert({ ...parsed.data, store_id: req.storeId! })
    .select("*")
    .single();

  if (error) throw new ApiError(500, error.message);
  res.status(201).json({ data });
}

export async function updateItem(req: Request, res: Response) {
  const parsed = updateItemSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid item payload", parsed.error.flatten());

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
  const { error } = await supabase
    .from("items")
    .delete()
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!);

  if (error) throw new ApiError(500, error.message);
  res.status(204).send();
}
