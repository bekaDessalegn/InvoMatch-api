import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import { signStoragePath } from "../services/storage";
import { sortDeliveryLineItems } from "../utils/order";
import { assertCanEdit, isManager, ownedInvoiceIds, withCreatorNames } from "../utils/access";
import { type DeliveryLineForStatus, matchStatusForQuantity, rollupDeliveryStatus } from "../utils/deliveryStatus";

const createDeliverySchema = z.object({
  invoice_id: z.string().uuid(),
  // Storage paths returned by POST /deliveries/analyze — not public URLs.
  photo_paths: z.array(z.string()).optional().default([]),
  status: z.enum(["pending", "verified", "discrepancy"]).optional().default("pending"),
});

const updateDeliverySchema = createDeliverySchema.partial();

const upsertDeliveryLineItemSchema = z.object({
  id: z.string().uuid().optional(),
  invoice_line_item_id: z.string().uuid(),
  detected_quantity: z.number().nullable().optional(),
  confirmed_quantity: z.number().nullable().optional(),
  match_status: z.enum(["matched", "needs_review", "missing"]),
});

const DELIVERY_SELECT =
  "*, invoices(invoice_number, vendor_id, created_by, vendors(name)), delivery_line_items(*, invoice_line_items(raw_name, quantity, unit_price, created_at))";

/** Replaces each delivery's stored photo paths with short-lived signed URLs. */
async function signDeliveryPhotos<T extends { photo_paths: string[] }>(
  deliveries: T[]
): Promise<(T & { photo_urls: (string | null)[] })[]> {
  return Promise.all(
    deliveries.map(async (d) => ({
      ...d,
      photo_urls: await Promise.all(d.photo_paths.map((path) => signStoragePath("delivery-photos", path))),
    }))
  );
}

/** Status from corrected quantities, and write it back when the stored value is stale. */
async function withRolledUpStatus<
  T extends { id: string; status: string; delivery_line_items?: DeliveryLineForStatus[] | null },
>(storeId: string, deliveries: T[]): Promise<T[]> {
  const stale: { id: string; status: string }[] = [];
  const next = deliveries.map((delivery) => {
    const status = rollupDeliveryStatus(delivery.delivery_line_items, delivery.status);
    if (status !== delivery.status) stale.push({ id: delivery.id, status });
    return { ...delivery, status };
  });

  await Promise.all(
    stale.map((row) =>
      supabase.from("deliveries").update({ status: row.status }).eq("id", row.id).eq("store_id", storeId)
    )
  );
  return next;
}

function canViewDelivery(
  req: Request,
  delivery: { created_by?: string | null; invoices?: { created_by?: string | null } | null }
): boolean {
  if (isManager(req.storeRole)) return true;
  return delivery.created_by === req.userId || delivery.invoices?.created_by === req.userId;
}

export async function listDeliveries(req: Request, res: Response) {
  let query = supabase
    .from("deliveries")
    .select(DELIVERY_SELECT)
    .eq("store_id", req.storeId!)
    .order("created_at", { ascending: false });

  if (req.query.status) {
    query = query.eq("status", req.query.status as string);
  }
  if (req.query.invoice_id) {
    query = query.eq("invoice_id", req.query.invoice_id as string);
  }
  if (!isManager(req.storeRole)) {
    const invoiceIds = await ownedInvoiceIds(req.storeId!, req.userId!);
    query =
      invoiceIds.length === 0
        ? query.eq("created_by", req.userId!)
        : query.or(`created_by.eq.${req.userId},invoice_id.in.(${invoiceIds.join(",")})`);
  }

  const { data, error } = await query;
  if (error) throw new ApiError(500, error.message);
  const signed = await withRolledUpStatus(req.storeId!, await signDeliveryPhotos(data ?? []));
  const named = await withCreatorNames(signed);
  res.json({
    data: named.map((delivery) => ({
      ...delivery,
      delivery_line_items: sortDeliveryLineItems(delivery.delivery_line_items),
    })),
  });
}

export async function getDelivery(req: Request, res: Response) {
  const { data, error } = await supabase
    .from("deliveries")
    .select(DELIVERY_SELECT)
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Delivery not found");
  if (!canViewDelivery(req, data)) throw new ApiError(404, "Delivery not found");
  const [withSignedPhoto] = await withRolledUpStatus(req.storeId!, await signDeliveryPhotos([data]));
  const [named] = await withCreatorNames(withSignedPhoto ? [withSignedPhoto] : []);
  res.json({
    data: {
      ...named,
      delivery_line_items: sortDeliveryLineItems(named?.delivery_line_items),
    },
  });
}

export async function createDelivery(req: Request, res: Response) {
  const parsed = createDeliverySchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid delivery payload", parsed.error.flatten());

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, created_by")
    .eq("id", parsed.data.invoice_id)
    .eq("store_id", req.storeId!)
    .maybeSingle();
  if (invoiceError) throw new ApiError(500, invoiceError.message);
  if (!invoice) throw new ApiError(404, "Invoice not found");
  assertCanEdit(req, invoice.created_by);

  const { data, error } = await supabase
    .from("deliveries")
    .insert({ ...parsed.data, store_id: req.storeId!, created_by: req.userId! })
    .select(DELIVERY_SELECT)
    .single();

  if (error) throw new ApiError(500, error.message);
  const [withSignedPhoto] = await signDeliveryPhotos([data]);
  res.status(201).json({ data: withSignedPhoto });
}

export async function updateDelivery(req: Request, res: Response) {
  const parsed = updateDeliverySchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid delivery payload", parsed.error.flatten());

  const { data: existing, error: existingError } = await supabase
    .from("deliveries")
    .select("created_by")
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();
  if (existingError) throw new ApiError(500, existingError.message);
  if (!existing) throw new ApiError(404, "Delivery not found");
  assertCanEdit(req, existing.created_by);

  const { data, error } = await supabase
    .from("deliveries")
    .update(parsed.data)
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .select("*")
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Delivery not found");
  res.json({ data });
}

export async function deleteDelivery(req: Request, res: Response) {
  const { data: existing, error: existingError } = await supabase
    .from("deliveries")
    .select("created_by")
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();
  if (existingError) throw new ApiError(500, existingError.message);
  if (!existing) throw new ApiError(404, "Delivery not found");
  assertCanEdit(req, existing.created_by);

  const { error } = await supabase
    .from("deliveries")
    .delete()
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!);

  if (error) throw new ApiError(500, error.message);
  res.status(204).send();
}

/** Upserts the reviewed match status / confirmed quantities for a delivery's line items. */
export async function upsertDeliveryLineItems(req: Request, res: Response) {
  const parsed = z.array(upsertDeliveryLineItemSchema).safeParse(req.body.line_items);
  if (!parsed.success) throw new ApiError(400, "Invalid delivery line items payload", parsed.error.flatten());

  // Confirm the delivery belongs to this store before writing to it.
  const { data: delivery, error: deliveryError } = await supabase
    .from("deliveries")
    .select("id, created_by")
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();

  if (deliveryError) throw new ApiError(500, deliveryError.message);
  if (!delivery) throw new ApiError(404, "Delivery not found");
  assertCanEdit(req, delivery.created_by);

  const lineIds = parsed.data.map((li) => li.invoice_line_item_id);
  const { data: invoiceLines, error: linesError } = await supabase
    .from("invoice_line_items")
    .select("id, quantity")
    .in("id", lineIds);
  if (linesError) throw new ApiError(500, linesError.message);
  const expectedById = new Map((invoiceLines ?? []).map((li) => [li.id as string, Number(li.quantity)]));

  const rows = parsed.data.map((li) => {
    const expected = expectedById.get(li.invoice_line_item_id);
    const confirmed = li.confirmed_quantity;
    const matchStatus =
      expected == null ? li.match_status : matchStatusForQuantity(expected, confirmed ?? null);
    return { ...li, match_status: matchStatus, delivery_id: req.params.id, store_id: req.storeId! };
  });

  const { data, error } = await supabase.from("delivery_line_items").upsert(rows).select("*");
  if (error) throw new ApiError(500, error.message);

  const overallStatus = rollupDeliveryStatus(
    rows.map((row) => ({
      confirmed_quantity: row.confirmed_quantity,
      invoice_line_items: { quantity: expectedById.get(row.invoice_line_item_id) ?? null },
    })),
    "pending"
  );

  const { error: statusError } = await supabase
    .from("deliveries")
    .update({ status: overallStatus })
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!);
  if (statusError) throw new ApiError(500, statusError.message);

  res.json({ data, status: overallStatus });
}
