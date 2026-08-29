import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import { signStoragePath } from "../services/storage";

const lineItemSchema = z.object({
  vendor_item_id: z.string().uuid().nullable().optional(),
  raw_name: z.string().min(1),
  quantity: z.number(),
  unit_price: z.number(),
});

const createInvoiceSchema = z.object({
  vendor_id: z.string().uuid(),
  invoice_number: z.string().min(1),
  invoice_date: z.string(), // ISO date
  source_type: z.enum(["photo", "pdf"]),
  status: z.enum(["draft", "confirmed"]).optional().default("draft"),
  subtotal: z.number(),
  tax: z.number(),
  total: z.number(),
  // Storage path returned by POST /invoices/parse — not a public URL.
  photo_url: z.string().nullable().optional(),
  line_items: z.array(lineItemSchema).optional().default([]),
});

const updateInvoiceSchema = createInvoiceSchema
  .omit({ line_items: true })
  .partial();

/** Replaces each invoice's stored photo path with a short-lived signed URL. */
async function signInvoicePhotos<T extends { photo_url: string | null }>(invoices: T[]): Promise<T[]> {
  return Promise.all(
    invoices.map(async (inv) => ({ ...inv, photo_url: await signStoragePath("invoice-photos", inv.photo_url) }))
  );
}

export async function listInvoices(req: Request, res: Response) {
  let query = supabase
    .from("invoices")
    .select("*, vendors(name)")
    .eq("store_id", req.storeId!)
    .order("created_at", { ascending: false });

  if (req.query.vendor_id) {
    query = query.eq("vendor_id", req.query.vendor_id as string);
  }
  if (req.query.status) {
    query = query.eq("status", req.query.status as string);
  }

  const { data, error } = await query;
  if (error) throw new ApiError(500, error.message);
  res.json({ data: await signInvoicePhotos(data ?? []) });
}

export async function getInvoice(req: Request, res: Response) {
  const { data, error } = await supabase
    .from("invoices")
    .select("*, vendors(name), invoice_line_items(*)")
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Invoice not found");
  const [withSignedPhoto] = await signInvoicePhotos([data]);
  res.json({ data: withSignedPhoto });
}

export async function createInvoice(req: Request, res: Response) {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid invoice payload", parsed.error.flatten());

  const { line_items, ...invoiceFields } = parsed.data;
  const storeId = req.storeId!;

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({ ...invoiceFields, store_id: storeId })
    .select("*")
    .single();

  if (invoiceError) throw new ApiError(500, invoiceError.message);

  if (line_items.length > 0) {
    const rows = line_items.map((li) => ({
      ...li,
      invoice_id: invoice.id,
      store_id: storeId,
      total_price: li.quantity * li.unit_price,
    }));

    const { error: lineItemsError } = await supabase.from("invoice_line_items").insert(rows);
    if (lineItemsError) throw new ApiError(500, lineItemsError.message);
  }

  res.status(201).json({ data: invoice });
}

export async function updateInvoice(req: Request, res: Response) {
  const parsed = updateInvoiceSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid invoice payload", parsed.error.flatten());

  const { data, error } = await supabase
    .from("invoices")
    .update(parsed.data)
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .select("*")
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Invoice not found");
  res.json({ data });
}

export async function deleteInvoice(req: Request, res: Response) {
  const { error } = await supabase
    .from("invoices")
    .delete()
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!);

  if (error) throw new ApiError(500, error.message);
  res.status(204).send();
}

/**
 * POST /invoices/:id/confirm
 *
 * Locks in a draft invoice: for every line item, finds or creates the
 * matching canonical `items` row and `vendor_items` link, then records a
 * `price_history` entry. This is what actually powers the catalog and price
 * alerts — nothing shows up there until an invoice is confirmed.
 */
export async function confirmInvoice(req: Request, res: Response) {
  const storeId = req.storeId!;

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("*, invoice_line_items(*)")
    .eq("id", req.params.id)
    .eq("store_id", storeId)
    .maybeSingle();

  if (invoiceError) throw new ApiError(500, invoiceError.message);
  if (!invoice) throw new ApiError(404, "Invoice not found");
  if (invoice.status === "confirmed") throw new ApiError(400, "Invoice is already confirmed");

  const lineItems: { id: string; raw_name: string; unit_price: number; vendor_item_id: string | null }[] =
    invoice.invoice_line_items ?? [];

  for (const line of lineItems) {
    let itemId: string;
    const { data: existingItem, error: findItemError } = await supabase
      .from("items")
      .select("id")
      .eq("store_id", storeId)
      .ilike("canonical_name", line.raw_name)
      .maybeSingle();
    if (findItemError) throw new ApiError(500, findItemError.message);

    if (existingItem) {
      itemId = existingItem.id;
    } else {
      const { data: newItem, error: createItemError } = await supabase
        .from("items")
        .insert({ store_id: storeId, canonical_name: line.raw_name })
        .select("id")
        .single();
      if (createItemError) throw new ApiError(500, createItemError.message);
      itemId = newItem.id;
    }

    let vendorItemId: string;
    const { data: existingVendorItem, error: findViError } = await supabase
      .from("vendor_items")
      .select("id")
      .eq("store_id", storeId)
      .eq("vendor_id", invoice.vendor_id)
      .eq("item_id", itemId)
      .maybeSingle();
    if (findViError) throw new ApiError(500, findViError.message);

    if (existingVendorItem) {
      vendorItemId = existingVendorItem.id;
    } else {
      const { data: newVendorItem, error: createViError } = await supabase
        .from("vendor_items")
        .insert({ store_id: storeId, vendor_id: invoice.vendor_id, item_id: itemId, vendor_description: line.raw_name })
        .select("id")
        .single();
      if (createViError) throw new ApiError(500, createViError.message);
      vendorItemId = newVendorItem.id;
    }

    const { error: linkError } = await supabase
      .from("invoice_line_items")
      .update({ vendor_item_id: vendorItemId })
      .eq("id", line.id);
    if (linkError) throw new ApiError(500, linkError.message);

    const { error: priceError } = await supabase.from("price_history").insert({
      store_id: storeId,
      item_id: itemId,
      vendor_id: invoice.vendor_id,
      invoice_id: invoice.id,
      price: line.unit_price,
      recorded_at: invoice.invoice_date,
    });
    if (priceError) throw new ApiError(500, priceError.message);
  }

  const { data: confirmed, error: updateError } = await supabase
    .from("invoices")
    .update({ status: "confirmed" })
    .eq("id", invoice.id)
    .select("*, vendors(name), invoice_line_items(*)")
    .single();
  if (updateError) throw new ApiError(500, updateError.message);

  const [withSignedPhoto] = await signInvoicePhotos([confirmed]);
  res.json({ data: withSignedPhoto });
}
