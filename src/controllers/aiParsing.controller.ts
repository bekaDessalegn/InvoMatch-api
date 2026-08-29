import type { Request, Response } from "express";

import { supabase } from "../db/supabase";
import { analyzeDeliveryPhoto } from "../services/deliveryAnalysis";
import { parseInvoiceDocument } from "../services/invoiceParsing";
import { signStoragePath, uploadToStorage } from "../services/storage";
import { ApiError } from "../middleware/errorHandler";

/**
 * POST /invoices/parse
 *
 * Accepts an invoice photo/PDF upload (`multipart/form-data`, field name
 * "file"), sends it to Claude for structured extraction, and — if it's a
 * genuine invoice — stores the original file and returns everything the
 * Invoice Review screen needs to let the user confirm/edit before saving.
 *
 * Returns 422 (not 500) when the upload clearly isn't a usable invoice, so
 * the app can prompt the user to retake/reselect it instead of showing a
 * generic error.
 */
export async function parseInvoice(req: Request, res: Response) {
  if (!req.file) {
    throw new ApiError(400, "Expected a multipart/form-data upload with field name 'file'.");
  }

  const storeId = req.storeId!;
  const result = await parseInvoiceDocument({ buffer: req.file.buffer, mimetype: req.file.mimetype });

  if (!result.isInvoice) {
    throw new ApiError(422, result.rejectionReason ?? "This doesn't look like a valid invoice. Please retake it.");
  }

  const photoPath = await uploadToStorage("invoice-photos", storeId, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
  });
  const photoUrl = await signStoragePath("invoice-photos", photoPath);

  let matchedVendor: { id: string; name: string } | null = null;
  if (result.vendorName) {
    const { data: vendors, error } = await supabase
      .from("vendors")
      .select("id, name")
      .eq("store_id", storeId)
      .ilike("name", result.vendorName);
    if (error) throw new ApiError(500, error.message);
    matchedVendor = vendors?.[0] ?? null;
  }

  res.json({
    data: {
      photo_path: photoPath,
      photo_url: photoUrl,
      source_type: req.file.mimetype === "application/pdf" ? "pdf" : "photo",
      vendor: {
        matched_id: matchedVendor?.id ?? null,
        matched_name: matchedVendor?.name ?? null,
        parsed_name: result.vendorName,
      },
      invoice_number: result.invoiceNumber,
      invoice_date: result.invoiceDate,
      line_items: result.lineItems.map((li) => ({ raw_name: li.name, quantity: li.quantity, unit_price: li.unit_price })),
      subtotal: result.subtotal,
      tax: result.tax,
      total: result.total,
    },
  });
}

/**
 * POST /deliveries/analyze
 *
 * Accepts a delivery photo upload (`multipart/form-data`, field name
 * "file") plus an `invoice_id` field, fetches that invoice's expected line
 * items, and asks Claude to compare the photo against them.
 *
 * Returns 422 when the photo clearly isn't a usable shot of the delivered
 * goods, so the app can ask the user to retake it.
 */
export async function analyzeDelivery(req: Request, res: Response) {
  if (!req.file) {
    throw new ApiError(400, "Expected a multipart/form-data upload with field name 'file'.");
  }
  const invoiceId = req.body.invoice_id as string | undefined;
  if (!invoiceId) throw new ApiError(400, "Expected an 'invoice_id' field identifying which invoice to match against.");

  const storeId = req.storeId!;
  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, invoice_line_items(id, raw_name, quantity)")
    .eq("id", invoiceId)
    .eq("store_id", storeId)
    .maybeSingle();

  if (invoiceError) throw new ApiError(500, invoiceError.message);
  if (!invoice) throw new ApiError(404, "Invoice not found");

  const lineItems: { id: string; raw_name: string; quantity: number }[] = invoice.invoice_line_items ?? [];
  if (lineItems.length === 0) {
    throw new ApiError(400, "This invoice has no line items to match a delivery against.");
  }

  const expectedItems = lineItems.map((li, index) => ({ index, name: li.raw_name, expectedQuantity: li.quantity }));
  const result = await analyzeDeliveryPhoto({ buffer: req.file.buffer, mimetype: req.file.mimetype }, expectedItems);

  if (!result.isDeliveryPhoto) {
    throw new ApiError(422, result.rejectionReason ?? "This doesn't look like a photo of the delivery. Please retake it.");
  }

  const photoPath = await uploadToStorage("delivery-photos", storeId, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
  });
  const photoUrl = await signStoragePath("delivery-photos", photoPath);

  const matchByIndex = new Map(result.matches.map((m) => [m.index, m]));

  res.json({
    data: {
      photo_path: photoPath,
      photo_url: photoUrl,
      line_items: lineItems.map((li, index) => {
        const match = matchByIndex.get(index);
        return {
          invoice_line_item_id: li.id,
          raw_name: li.raw_name,
          expected_quantity: li.quantity,
          detected_quantity: match?.detectedQuantity ?? null,
          match_status: match?.matchStatus ?? "needs_review",
          note: match?.note ?? null,
        };
      }),
    },
  });
}
