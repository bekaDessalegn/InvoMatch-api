import type Anthropic from "@anthropic-ai/sdk";

import { anthropic, CLAUDE_MODEL } from "./anthropic";

export interface ExpectedDeliveryItem {
  index: number;
  name: string;
  expectedQuantity: number;
}

export interface DeliveryLineMatch {
  index: number;
  detectedQuantity: number | null;
  matchStatus: "matched" | "needs_review" | "missing";
  note: string | null;
}

export interface AnalyzedDeliveryResult {
  isDeliveryPhoto: boolean;
  rejectionReason: string | null;
  matches: DeliveryLineMatch[];
}

const TOOL_NAME = "record_delivery_match";

const deliveryTool: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Records how a photographed physical delivery compares against the expected invoice line items.",
  input_schema: {
    type: "object",
    properties: {
      is_delivery_photo: {
        type: "boolean",
        description:
          "true only if this is clearly a photo of physical goods/boxes/products being delivered. false for anything else (a document, a blurry/unusable shot, an unrelated photo, etc.).",
      },
      rejection_reason: {
        type: "string",
        description:
          "Required when is_delivery_photo is false. One short, friendly sentence explaining the issue, e.g. 'This looks like a photo of a receipt, not the delivered goods.' or 'The photo is too dark to make out any products — please retake it with better lighting.'",
      },
      matches: {
        type: "array",
        description: "One entry per expected item provided in the prompt, in the same order.",
        items: {
          type: "object",
          properties: {
            line_item_index: { type: "integer", description: "0-based index into the expected items list provided in the prompt." },
            detected_quantity: { type: "number", description: "How many units of this item you can count/identify in the photo. 0 if none visible." },
            match_status: { type: "string", enum: ["matched", "needs_review", "missing"] },
            note: { type: "string", description: "Optional short note, e.g. 'packaging looks different than expected'." },
          },
          required: ["line_item_index", "match_status"],
        },
      },
    },
    required: ["is_delivery_photo"],
  },
};

/**
 * Sends a delivery photo + the list of items expected per the invoice to
 * Claude, and gets back a per-item match verdict. Flags photos that clearly
 * aren't of a physical delivery at all.
 */
export async function analyzeDeliveryPhoto(
  file: { buffer: Buffer; mimetype: string },
  expectedItems: ExpectedDeliveryItem[]
): Promise<AnalyzedDeliveryResult> {
  const expectedItemsText = expectedItems
    .map((item) => `${item.index}. ${item.name} — expected qty: ${item.expectedQuantity}`)
    .join("\n");

  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    tools: [deliveryTool],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: file.mimetype as "image/jpeg" | "image/png" | "image/webp",
              data: file.buffer.toString("base64"),
            },
          },
          {
            type: "text",
            text:
              "A store employee just photographed a physical delivery to check it against an invoice. First decide " +
              "whether this is actually a usable photo of delivered goods (not a document, not something unrelated, " +
              "not too dark/blurry to identify products). If it is, compare what you see against this list of items " +
              `expected from the invoice:\n\n${expectedItemsText}\n\n` +
              "For every expected item (by its index), report how many units you can identify in the photo and a " +
              "match_status: 'matched' if the counted quantity matches (or closely matches) what's expected, " +
              "'needs_review' if you found the item but the quantity looks off or you're unsure, or 'missing' if you " +
              "can't find it in the photo at all. If the photo shows items not on the list, ignore them.",
          },
        ],
      },
    ],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME
  );
  if (!toolUse) {
    return { isDeliveryPhoto: false, rejectionReason: "Claude couldn't analyze this photo. Please try again.", matches: [] };
  }

  const input = toolUse.input as Record<string, unknown>;
  const isDeliveryPhoto = input.is_delivery_photo === true;

  return {
    isDeliveryPhoto,
    rejectionReason: isDeliveryPhoto
      ? null
      : ((input.rejection_reason as string) ?? "This doesn't look like a photo of the delivery."),
    matches: Array.isArray(input.matches)
      ? (input.matches as Record<string, unknown>[]).map((m) => ({
          index: Number(m.line_item_index),
          detectedQuantity: m.detected_quantity != null ? Number(m.detected_quantity) : null,
          matchStatus: (m.match_status as DeliveryLineMatch["matchStatus"]) ?? "needs_review",
          note: (m.note as string) ?? null,
        }))
      : [],
  };
}
