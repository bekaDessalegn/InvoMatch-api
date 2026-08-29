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
        description: "Every itemized product line on the invoice.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            quantity: { type: "number" },
            unit_price: { type: "number", description: "Price per unit, not the line total." },
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

/**
 * Sends an invoice photo/PDF to Claude and returns structured line items, or
 * flags the upload as not being a valid invoice at all (blurry, wrong
 * subject, etc.) so the caller can ask the user to retake/reselect it.
 */
export async function parseInvoiceDocument(file: { buffer: Buffer; mimetype: string }): Promise<ParsedInvoiceResult> {
  const documentBlock: Anthropic.ContentBlockParam =
    file.mimetype === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.buffer.toString("base64") } }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: file.mimetype as "image/jpeg" | "image/png" | "image/webp",
            data: file.buffer.toString("base64"),
          },
        };

  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    tools: [invoiceTool],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [
          documentBlock,
          {
            type: "text",
            text:
              "This is a photo or document a store owner just captured, hoping to log a supplier invoice. " +
              "Carefully determine whether it actually is an invoice/receipt/packing slip. If yes, extract every " +
              "line item with quantity and unit price, plus the vendor name, invoice number, date, subtotal, tax, " +
              "and total. If any totals aren't printed, compute subtotal as the sum of line item totals and leave " +
              "tax as 0 unless a tax amount is visible. If it's not a valid invoice, set is_invoice to false and " +
              "explain why in rejection_reason instead of guessing at data.",
          },
        ],
      },
    ],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME
  );
  if (!toolUse) {
    return {
      isInvoice: false,
      rejectionReason: "Claude couldn't analyze this file. Please try again.",
      vendorName: "",
      invoiceNumber: "",
      invoiceDate: null,
      lineItems: [],
      subtotal: 0,
      tax: 0,
      total: 0,
    };
  }

  const input = toolUse.input as Record<string, unknown>;
  const isInvoice = input.is_invoice === true;

  return {
    isInvoice,
    rejectionReason: isInvoice ? null : ((input.rejection_reason as string) ?? "This doesn't look like a valid invoice."),
    vendorName: (input.vendor_name as string) ?? "",
    invoiceNumber: (input.invoice_number as string) ?? "",
    invoiceDate: (input.invoice_date as string) ?? null,
    lineItems: Array.isArray(input.line_items)
      ? (input.line_items as ParsedInvoiceLineItem[]).map((li) => ({
          name: String(li.name ?? "").trim() || "Unlabeled item",
          quantity: Number(li.quantity) || 0,
          unit_price: Number(li.unit_price) || 0,
        }))
      : [],
    subtotal: Number(input.subtotal) || 0,
    tax: Number(input.tax) || 0,
    total: Number(input.total) || 0,
  };
}
