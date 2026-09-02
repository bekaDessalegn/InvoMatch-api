import type { Request, Response } from "express";

import { supabase } from "../db/supabase";
import { analyzeDeliveryPhoto } from "../services/deliveryAnalysis";
import { parseInvoiceDocument } from "../services/invoiceParsing";
import { signStoragePath, uploadToStorage } from "../services/storage";
import { ApiError } from "../middleware/errorHandler";

/**
 * POST /invoices/parse
 *
 * Accepts one or more invoice photos, or a single PDF (`multipart/form-data`,
 * field name "files"), sends them to Claude in one call for structured
 * extraction, and — if it's a genuine invoice — stores every file and
 * returns everything the Invoice Review screen needs to let the user
 * confirm/edit before saving.
 *
 * Returns 422 (not 500) when the upload clearly isn't a usable invoice, so
 * the app can prompt the user to retake/reselect it instead of showing a
 * generic error.
 */
export async function parseInvoice(req: Request, res: Response) {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    throw new ApiError(400, "Expected a multipart/form-data upload with field name 'files'.");
  }
  if (files.length > 1 && files.some((f) => f.mimetype === "application/pdf")) {
    throw new ApiError(400, "Only one PDF can be uploaded at a time — a PDF can already hold multiple pages.");
  }
  const firstFile = files[0]!;

  const storeId = req.storeId!;
  const result = await parseInvoiceDocument(files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })));

  if (!result.isInvoice) {
    throw new ApiError(422, result.rejectionReason ?? "This doesn't look like a valid invoice. Please retake it.");
  }

  const photoPaths = await Promise.all(
    files.map((f) => uploadToStorage("invoice-photos", storeId, { buffer: f.buffer, mimetype: f.mimetype }))
  );
  const photoUrls = await Promise.all(photoPaths.map((path) => signStoragePath("invoice-photos", path)));

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
      photo_paths: photoPaths,
      photo_urls: photoUrls,
      source_type: firstFile.mimetype === "application/pdf" ? "pdf" : "photo",
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
 * Accepts one or more delivery photos (`multipart/form-data`, field name
 * "files") plus an `invoice_id` field, fetches that invoice's expected line
 * items, and asks Claude to compare all the photos together against them.
 *
 * Returns 422 when none of the photos are usable shots of the delivered
 * goods, so the app can ask the user to retake them.
 */
export async function analyzeDelivery(req: Request, res: Response) {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    throw new ApiError(400, "Expected a multipart/form-data upload with field name 'files'.");
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
  const result = await analyzeDeliveryPhoto(
    files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })),
    expectedItems
  );

  if (!result.isDeliveryPhoto) {
    throw new ApiError(422, result.rejectionReason ?? "This doesn't look like a photo of the delivery. Please retake it.");
  }

  const photoPaths = await Promise.all(
    files.map((f) => uploadToStorage("delivery-photos", storeId, { buffer: f.buffer, mimetype: f.mimetype }))
  );
  const photoUrls = await Promise.all(photoPaths.map((path) => signStoragePath("delivery-photos", path)));

  const matchByIndex = new Map(result.matches.map((m) => [m.index, m]));

  res.json({
    data: {
      photo_paths: photoPaths,
      photo_urls: photoUrls,
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
