import type Anthropic from "@anthropic-ai/sdk";

import { anthropic, CLAUDE_MODEL } from "./anthropic";

export interface ParsedInvoiceLineItem {
  name: string;
  quantity: number;
  unit_price: number;
}

export interface ParsedInvoiceResult {
  isInvoice: boolean;
  rejectionReason: string | null;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string | null; // ISO date, may be null if illegible
  lineItems: ParsedInvoiceLineItem[];
  subtotal: number;
  tax: number;
  total: number;
}

const TOOL_NAME = "record_invoice";
const MAX_OUTPUT_TOKENS = 16384;
const MAX_CONTINUATIONS = 3;

const invoiceTool: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    "Records the structured contents of a supplier invoice, receipt, or packing slip photo/PDF that was just analyzed.",
  input_schema: {
    type: "object",
    properties: {
      is_invoice: {
        type: "boolean",
        description:
          "true only if this is clearly a supplier invoice, receipt, bill, or itemized packing slip. false for anything else (a random photo, a blank/blurry image, a person, a menu, etc.).",
      },
      rejection_reason: {
        type: "string",
        description:
          "Required when is_invoice is false. One short, friendly sentence explaining what's wrong so the user knows what to fix, e.g. 'This looks like a photo of food, not an invoice.' or 'The image is too blurry to read — please retake it in better light.'",
      },
      vendor_name: { type: "string", description: "The supplier/vendor name printed on the invoice." },
      invoice_number: { type: "string", description: "The invoice or receipt number." },
      invoice_date: { type: "string", description: "The invoice date in ISO 8601 format (YYYY-MM-DD)." },
      line_items: {
        type: "array",
        description:
          "Every billed product line from every page. Skip barcodes, pallet IDs, headers, and $0.00 / out-of-stock rows.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            quantity: { type: "number" },
            unit_price: {
              type: "number",
              description:
                "Price per unit the store actually pays. If the invoice has Price/Disc/Net columns, use Net — not the pre-discount Price and not the line Total.",
            },
          },
          required: ["name", "quantity", "unit_price"],
        },
      },
      subtotal: { type: "number" },
      tax: { type: "number" },
      total: { type: "number" },
    },
    required: ["is_invoice"],
  },
};

function fileToContentBlock(file: { buffer: Buffer; mimetype: string }): Anthropic.ContentBlockParam {
  return file.mimetype === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.buffer.toString("base64") } }
    : {
        type: "image",
        source: {
          type: "base64",
          media_type: file.mimetype as "image/jpeg" | "image/png" | "image/webp",
          data: file.buffer.toString("base64"),
        },
      };
}

function extractionPrompt(fileCount: number, isPdf: boolean): string {
  const pages =
    isPdf
      ? "This is a multi-page PDF invoice. Read EVERY page (including pages marked Continued / Page N of M). "
      : fileCount > 1
        ? "These are multiple photos, in order, of the same long supplier invoice — treat them as consecutive pages of one document, not separate invoices. "
        : "This is a photo or document a store owner just captured, hoping to log a supplier invoice. ";

  return (
    pages +
    "Carefully determine whether it actually is an invoice/receipt/packing slip. If yes, extract: " +
    "vendor name, invoice number, date, every billed product line with quantity and unit price, plus subtotal, tax, and total. " +
    "Rules for line items: include every product row with a quantity greater than 0; skip barcodes, UPC numbers, pallet IDs, " +
    "headers, signatures, and out-of-stock / $0.00 total rows. If the invoice has Price, Discount, and Net columns, unit_price " +
    "must be the Net (what the store pays), not the pre-discount Price and not the line Total. " +
    "Do not stop after the first page. If any totals aren't printed, compute subtotal as the sum of line totals and leave tax as 0 " +
    "unless a tax amount is visible. If it's not a valid invoice, set is_invoice to false and explain why in rejection_reason " +
    "instead of guessing at data."
  );
}

function emptyResult(rejectionReason: string): ParsedInvoiceResult {
  return {
    isInvoice: false,
    rejectionReason,
    vendorName: "",
    invoiceNumber: "",
    invoiceDate: null,
    lineItems: [],
    subtotal: 0,
    tax: 0,
    total: 0,
  };
}

function parseToolInput(input: Record<string, unknown>): ParsedInvoiceResult {
  const isInvoice = input.is_invoice === true;
  return {
    isInvoice,
    rejectionReason: isInvoice ? null : ((input.rejection_reason as string) ?? "This doesn't look like a valid invoice."),
    vendorName: (input.vendor_name as string) ?? "",
    invoiceNumber: (input.invoice_number as string) ?? "",
    invoiceDate: (input.invoice_date as string) ?? null,
    lineItems: Array.isArray(input.line_items)
      ? (input.line_items as ParsedInvoiceLineItem[])
          .map((li) => ({
            name: String(li.name ?? "").trim() || "Unlabeled item",
            quantity: Number(li.quantity) || 0,
            unit_price: Number(li.unit_price) || 0,
          }))
          .filter((li) => li.quantity > 0)
      : [],
    subtotal: Number(input.subtotal) || 0,
    tax: Number(input.tax) || 0,
    total: Number(input.total) || 0,
  };
}

/**
 * Sends one or more invoice photos (or a single PDF) to Claude in a single
 * message and returns structured line items, or flags the upload as not
 * being a valid invoice at all (blurry, wrong subject, etc.) so the caller
 * can ask the user to retake/reselect it.
 *
 * Long multi-page PDFs can overflow a small output budget; we retry with a
 * "continue" turn when Claude's response is cut off at max_tokens.
 */
export async function parseInvoiceDocument(
  files: { buffer: Buffer; mimetype: string }[]
): Promise<ParsedInvoiceResult> {
  const isPdf = files.some((f) => f.mimetype === "application/pdf");
  const documentBlocks = files.map(fileToContentBlock);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [...documentBlocks, { type: "text", text: extractionPrompt(files.length, isPdf) }],
    },
  ];

  let lastResult: ParsedInvoiceResult | null = null;

  for (let attempt = 0; attempt < MAX_CONTINUATIONS; attempt++) {
    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      tools: [invoiceTool],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages,
    });

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME
    );

    if (!toolUse) {
      return emptyResult("Claude couldn't analyze this file. Please try again.");
    }

    const truncated = message.stop_reason === "max_tokens";
    const parsed = parseToolInput(toolUse.input as Record<string, unknown>);

    if (!truncated && (parsed.lineItems.length > 0 || !parsed.isInvoice)) {
      return parsed;
    }

    lastResult = parsed;
    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content:
        "The previous extraction was incomplete or cut off. Call record_invoice again with the FULL invoice: " +
        "vendor, invoice number, date, and every billed product line from every page. Do not omit items.",
    });
  }

  return lastResult ?? emptyResult("Claude couldn't finish reading this invoice. Please try again.");
}
