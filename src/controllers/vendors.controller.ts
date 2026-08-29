import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";

const createVendorSchema = z.object({
  name: z.string().min(1),
  contact_info: z.string().nullable().optional(),
  payment_terms: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional().default("active"),
});

const updateVendorSchema = createVendorSchema.partial();

/**
 * Computes `total_spend_ytd` (sum of confirmed invoice totals since Jan 1 of
 * the current year) and `last_invoice_date` per vendor for this store. Small
 * businesses have a modest number of invoices, so a single query + in-memory
 * grouping is simpler and fast enough — no need for a DB view/RPC.
 */
async function attachVendorAggregates(storeId: string, vendors: Record<string, unknown>[]) {
  if (vendors.length === 0) return vendors;

  const { data: invoices, error } = await supabase
    .from("invoices")
    .select("vendor_id, total, invoice_date, status")
    .eq("store_id", storeId);

  if (error) throw new ApiError(500, error.message);

  const yearStart = `${new Date().getFullYear()}-01-01`;
  const totals = new Map<string, number>();
  const lastDates = new Map<string, string>();

  for (const inv of invoices ?? []) {
    if (inv.status !== "confirmed") continue;
    if (inv.invoice_date >= yearStart) {
      totals.set(inv.vendor_id, (totals.get(inv.vendor_id) ?? 0) + Number(inv.total));
    }
    const current = lastDates.get(inv.vendor_id);
    if (!current || inv.invoice_date > current) lastDates.set(inv.vendor_id, inv.invoice_date);
  }

  return vendors.map((v) => ({
    ...v,
    total_spend_ytd: totals.get(v.id as string) ?? 0,
    last_invoice_date: lastDates.get(v.id as string) ?? null,
  }));
}

export async function listVendors(req: Request, res: Response) {
  const { data, error } = await supabase
    .from("vendors")
    .select("*")
    .eq("store_id", req.storeId!)
    .order("created_at", { ascending: false });

  if (error) throw new ApiError(500, error.message);
  res.json({ data: await attachVendorAggregates(req.storeId!, data ?? []) });
}

export async function getVendor(req: Request, res: Response) {
  const { data, error } = await supabase
    .from("vendors")
    .select("*")
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Vendor not found");
  const [withAggregates] = await attachVendorAggregates(req.storeId!, [data]);
  res.json({ data: withAggregates });
}

export async function createVendor(req: Request, res: Response) {
  const parsed = createVendorSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid vendor payload", parsed.error.flatten());

  const { data, error } = await supabase
    .from("vendors")
    .insert({ ...parsed.data, store_id: req.storeId! })
    .select("*")
    .single();

  if (error) throw new ApiError(500, error.message);
  res.status(201).json({ data });
}

export async function updateVendor(req: Request, res: Response) {
  const parsed = updateVendorSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid vendor payload", parsed.error.flatten());

  const { data, error } = await supabase
    .from("vendors")
    .update(parsed.data)
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .select("*")
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Vendor not found");
  res.json({ data });
}

export async function deleteVendor(req: Request, res: Response) {
  const { error } = await supabase
    .from("vendors")
    .delete()
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!);

  if (error) throw new ApiError(500, error.message);
  res.status(204).send();
}
