import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import { signStoragePath } from "../services/storage";

const createDeliverySchema = z.object({
  invoice_id: z.string().uuid(),
  // Storage path returned by POST /deliveries/analyze — not a public URL.
  photo_url: z.string().nullable().optional(),
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
  "*, invoices(invoice_number, vendor_id, vendors(name)), delivery_line_items(*, invoice_line_items(raw_name, quantity, unit_price))";

/** Replaces each delivery's stored photo path with a short-lived signed URL. */
async function signDeliveryPhotos<T extends { photo_url: string | null }>(deliveries: T[]): Promise<T[]> {
  return Promise.all(
    deliveries.map(async (d) => ({ ...d, photo_url: await signStoragePath("delivery-photos", d.photo_url) }))
  );
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

  const { data, error } = await query;
  if (error) throw new ApiError(500, error.message);
  res.json({ data: await signDeliveryPhotos(data ?? []) });
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
  const [withSignedPhoto] = await signDeliveryPhotos([data]);
  res.json({ data: withSignedPhoto });
}

export async function createDelivery(req: Request, res: Response) {
  const parsed = createDeliverySchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid delivery payload", parsed.error.flatten());

  const { data, error } = await supabase
    .from("deliveries")
    .insert({ ...parsed.data, store_id: req.storeId! })
    .select(DELIVERY_SELECT)
    .single();

  if (error) throw new ApiError(500, error.message);
  const [withSignedPhoto] = await signDeliveryPhotos([data]);
  res.status(201).json({ data: withSignedPhoto });
}

export async function updateDelivery(req: Request, res: Response) {
  const parsed = updateDeliverySchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid delivery payload", parsed.error.flatten());

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
    .select("id")
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!)
    .maybeSingle();

  if (deliveryError) throw new ApiError(500, deliveryError.message);
  if (!delivery) throw new ApiError(404, "Delivery not found");

  const rows = parsed.data.map((li) => ({ ...li, delivery_id: req.params.id, store_id: req.storeId! }));

  const { data, error } = await supabase.from("delivery_line_items").upsert(rows).select("*");
  if (error) throw new ApiError(500, error.message);

  // Roll the individual line-item verdicts up into the delivery's overall
  // status: any missing item is a discrepancy worth flagging; anything else
  // that isn't a clean match still needs a human look before "verified".
  const statuses = data?.map((row) => row.match_status) ?? [];
  const overallStatus = statuses.includes("missing")
    ? "discrepancy"
    : statuses.every((s) => s === "matched")
      ? "verified"
      : "pending";

  const { error: statusError } = await supabase
    .from("deliveries")
    .update({ status: overallStatus })
    .eq("id", req.params.id)
    .eq("store_id", req.storeId!);
  if (statusError) throw new ApiError(500, statusError.message);

  res.json({ data, status: overallStatus });
}
