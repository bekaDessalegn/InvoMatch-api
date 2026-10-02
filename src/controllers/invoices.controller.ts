import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import { signStoragePath } from "../services/storage";
import { sortByCreatedAt } from "../utils/order";
import { rollupDeliveryStatus } from "../utils/deliveryStatus";

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
  // Storage paths returned by POST /invoices/parse — not public URLs.
  photo_paths: z.array(z.string()).optional().default([]),
  line_items: z.array(lineItemSchema).optional().default([]),
});

const updateInvoiceSchema = createInvoiceSchema
  .omit({ line_items: true })
  .partial();

/** Replaces each invoice's stored photo paths with short-lived signed URLs. */
async function signInvoicePhotos<T extends { photo_paths: string[] }>(
  invoices: T[]
): Promise<(T & { photo_urls: (string | null)[] })[]> {
  return Promise.all(
    invoices.map(async (inv) => ({
      ...inv,
      photo_urls: await Promise.all(inv.photo_paths.map((path) => signStoragePath("invoice-photos", path))),
    }))
  );
}

/**
 * Attaches each invoice's most recent delivery status, so the app can tell
 * "confirmed, nothing delivered/verified yet" apart from "confirmed and the
 * delivery was actually checked against it" — a confirmed invoice on its
 * own isn't a success state, a verified delivery is.
 */
async function attachDeliveryStatus<T extends { id: string }>(
  storeId: string,
  invoices: T[]
): Promise<(T & { delivery_status: string | null })[]> {
  if (invoices.length === 0) return [];

  const { data: deliveries, error } = await supabase
    .from("deliveries")
    .select("id, invoice_id, status, created_at, delivery_line_items(confirmed_quantity, invoice_line_items(quantity))")
    .eq("store_id", storeId)
    .in(
      "invoice_id",
      invoices.map((inv) => inv.id)
    )
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);

  const latestByInvoice = new Map<string, NonNullable<typeof deliveries>[number]>();
  for (const delivery of deliveries ?? []) {
    if (!latestByInvoice.has(delivery.invoice_id)) latestByInvoice.set(delivery.invoice_id, delivery);
  }

  const statusByInvoice = new Map<string, string>();
  const stale: { id: string; status: string }[] = [];
  for (const [invoiceId, delivery] of latestByInvoice) {
    const status = rollupDeliveryStatus(delivery.delivery_line_items, delivery.status);
    statusByInvoice.set(invoiceId, status);
    if (status !== delivery.status) stale.push({ id: delivery.id, status });
  }

  await Promise.all(
    stale.map((row) =>
      supabase.from("deliveries").update({ status: row.status }).eq("id", row.id).eq("store_id", storeId)
    )
  );

  return invoices.map((inv) => ({ ...inv, delivery_status: statusByInvoice.get(inv.id) ?? null }));
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
  const withPhotos = await signInvoicePhotos(data ?? []);
  res.json({ data: await attachDeliveryStatus(req.storeId!, withPhotos) });
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
  const ordered = {
    ...data,
    invoice_line_items: sortByCreatedAt(data.invoice_line_items),
  };
  const [withSignedPhoto] = await signInvoicePhotos([ordered]);
  const [withDeliveryStatus] = await attachDeliveryStatus(req.storeId!, [withSignedPhoto]);
  res.json({ data: withDeliveryStatus });
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
    const stamp = Date.now();
    const rows = line_items.map((li, index) => ({
      ...li,
      invoice_id: invoice.id,
      store_id: storeId,
      total_price: li.quantity * li.unit_price,
      // 1ms apart so a later read can restore top-to-bottom invoice order.
      created_at: new Date(stamp + index).toISOString(),
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

  // Confirm used to do 4–6 Supabase round-trips *per line*. A 100-item
  // wholesale invoice became hundreds of sequential HTTP calls. Batch
  // instead: load existing catalog rows once, insert what's missing, then
  // link lines and write price history in bulk.
  if (lineItems.length > 0) {
    const { data: existingItems, error: itemsError } = await supabase
      .from("items")
      .select("id, canonical_name")
      .eq("store_id", storeId);
    if (itemsError) throw new ApiError(500, itemsError.message);

    const itemByName = new Map<string, string>();
    for (const item of existingItems ?? []) {
      itemByName.set(item.canonical_name.trim().toLowerCase(), item.id);
    }

    const missingItemNames: string[] = [];
    const queuedItemNames = new Set<string>();
    for (const line of lineItems) {
      const key = line.raw_name.trim().toLowerCase();
      if (!itemByName.has(key) && !queuedItemNames.has(key)) {
        queuedItemNames.add(key);
        missingItemNames.push(line.raw_name.trim() || line.raw_name);
      }
    }

    if (missingItemNames.length > 0) {
      const { data: createdItems, error: createItemsError } = await supabase
        .from("items")
        .insert(missingItemNames.map((canonical_name) => ({ store_id: storeId, canonical_name })))
        .select("id, canonical_name");
      if (createItemsError) throw new ApiError(500, createItemsError.message);
      for (const item of createdItems ?? []) {
        itemByName.set(item.canonical_name.trim().toLowerCase(), item.id);
      }
    }

    const { data: existingVendorItems, error: visError } = await supabase
      .from("vendor_items")
      .select("id, item_id")
      .eq("store_id", storeId)
      .eq("vendor_id", invoice.vendor_id);
    if (visError) throw new ApiError(500, visError.message);

    const vendorItemByItemId = new Map<string, string>();
    for (const vi of existingVendorItems ?? []) {
      vendorItemByItemId.set(vi.item_id, vi.id);
    }

    const missingVendorItems: { store_id: string; vendor_id: string; item_id: string; vendor_description: string }[] = [];
    const queuedVendorItems = new Set<string>();
    for (const line of lineItems) {
      const itemId = itemByName.get(line.raw_name.trim().toLowerCase());
      if (!itemId) throw new ApiError(500, `Couldn't match catalog item for "${line.raw_name}".`);
      if (!vendorItemByItemId.has(itemId) && !queuedVendorItems.has(itemId)) {
        queuedVendorItems.add(itemId);
        missingVendorItems.push({
          store_id: storeId,
          vendor_id: invoice.vendor_id,
          item_id: itemId,
          vendor_description: line.raw_name,
        });
      }
    }

    if (missingVendorItems.length > 0) {
      const { data: createdVis, error: createViError } = await supabase
        .from("vendor_items")
        .insert(missingVendorItems)
        .select("id, item_id");
      if (createViError) throw new ApiError(500, createViError.message);
      for (const vi of createdVis ?? []) {
        vendorItemByItemId.set(vi.item_id, vi.id);
      }
    }

    const lineIdsByVendorItem = new Map<string, string[]>();
    const priceRows: {
      store_id: string;
      item_id: string;
      vendor_id: string;
      invoice_id: string;
      price: number;
      recorded_at: string;
    }[] = [];

    for (const line of lineItems) {
      const itemId = itemByName.get(line.raw_name.trim().toLowerCase())!;
      const vendorItemId = vendorItemByItemId.get(itemId);
      if (!vendorItemId) throw new ApiError(500, `Couldn't link "${line.raw_name}" to this vendor.`);
      const ids = lineIdsByVendorItem.get(vendorItemId) ?? [];
      ids.push(line.id);
      lineIdsByVendorItem.set(vendorItemId, ids);
      priceRows.push({
        store_id: storeId,
        item_id: itemId,
        vendor_id: invoice.vendor_id,
        invoice_id: invoice.id,
        price: line.unit_price,
        recorded_at: invoice.invoice_date,
      });
    }

    const linkResults = await Promise.all(
      [...lineIdsByVendorItem.entries()].map(([vendorItemId, ids]) =>
        supabase.from("invoice_line_items").update({ vendor_item_id: vendorItemId }).in("id", ids)
      )
    );
    const linkError = linkResults.find((r) => r.error)?.error;
    if (linkError) throw new ApiError(500, linkError.message);

    const { error: priceError } = await supabase.from("price_history").insert(priceRows);
    if (priceError) throw new ApiError(500, priceError.message);
  }

  const { data: confirmed, error: updateError } = await supabase
    .from("invoices")
    .update({ status: "confirmed" })
    .eq("id", invoice.id)
    .select("*, vendors(name), invoice_line_items(*)")
    .single();
  if (updateError) throw new ApiError(500, updateError.message);

  const [withSignedPhoto] = await signInvoicePhotos([
    { ...confirmed, invoice_line_items: sortByCreatedAt(confirmed.invoice_line_items) },
  ]);
  const [withDeliveryStatus] = await attachDeliveryStatus(storeId, [withSignedPhoto]);
  res.json({ data: withDeliveryStatus });
}
