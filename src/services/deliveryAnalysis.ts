import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";

import { anthropic, CLAUDE_MODEL } from "./anthropic";
import { compressImageForVision } from "./imageCompress";

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
            detected_quantity: { type: "number", description: "How many units of this item you can count/identify in THESE photos. 0 if none visible." },
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

function isRequestTooLarge(err: unknown): boolean {
  return err instanceof APIError && err.status === 413;
}

function expectedItemsText(expectedItems: ExpectedDeliveryItem[]): string {
  return expectedItems.map((item) => `${item.index}. ${item.name} — expected qty: ${item.expectedQuantity}`).join("\n");
}

function matchStatusFor(detected: number, expected: number): DeliveryLineMatch["matchStatus"] {
  if (detected <= 0) return "missing";
  if (detected === expected) return "matched";
  const slack = Math.max(1, expected * 0.1);
  if (Math.abs(detected - expected) <= slack) return "matched";
  return "needs_review";
}

function parseToolResult(input: Record<string, unknown>): AnalyzedDeliveryResult {
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

function mergeResults(batches: AnalyzedDeliveryResult[], expectedItems: ExpectedDeliveryItem[]): AnalyzedDeliveryResult {
  const usable = batches.filter((b) => b.isDeliveryPhoto);
  if (usable.length === 0) {
    return (
      batches[0] ?? {
        isDeliveryPhoto: false,
        rejectionReason: "None of these photos look like a delivery. Please retake them.",
        matches: [],
      }
    );
  }

  const qty = new Map<number, number>();
  const notes = new Map<number, string>();
  for (const batch of usable) {
    for (const match of batch.matches) {
      qty.set(match.index, (qty.get(match.index) ?? 0) + (match.detectedQuantity ?? 0));
      if (match.note && !notes.has(match.index)) notes.set(match.index, match.note);
    }
  }

  return {
    isDeliveryPhoto: true,
    rejectionReason: null,
    matches: expectedItems.map((item) => {
      const detected = qty.get(item.index) ?? 0;
      return {
        index: item.index,
        detectedQuantity: detected,
        matchStatus: matchStatusFor(detected, item.expectedQuantity),
        note: notes.get(item.index) ?? null,
      };
    }),
  };
}

function promptFor(fileCount: number, expectedItems: ExpectedDeliveryItem[], isPartial: boolean): string {
  const items = expectedItemsText(expectedItems);
  const scope = isPartial
    ? "These photos are only PART of a larger delivery. Count only what you see in THESE photos — " +
      "do not try to match the invoice totals yet. Different photos are different stacks unless the " +
      "same stack is clearly shown twice."
    : "Look at all the photos together as one delivery. Different photos are typically different stacks; " +
      "do not double-count the same physical stack if it appears in more than one photo.";

  return (
    "A store employee photographed a physical delivery of stacked cases in a store aisle or back room. " +
    "First decide whether at least one of these photos is a usable shot of delivered goods (not a document, " +
    "not something unrelated, not too dark/blurry to identify products). If it isn't, set is_delivery_photo " +
    `to false and explain why.\n\n${scope} Count cases/packs/trays as the units on the invoice ` +
    `(e.g. a 12-pack of Modelo is one unit if the invoice line is for that 12-pack).\n\n${items}\n\n` +
    "For every expected item (by its index), report how many units you can identify in these photos " +
    `(0 if none). ${fileCount === 1 ? "There is one photo." : `There are ${fileCount} photos in this set.`}`
  );
}

async function callClaude(
  images: { buffer: Buffer; mimetype: string }[],
  expectedItems: ExpectedDeliveryItem[],
  isPartial: boolean
): Promise<AnalyzedDeliveryResult> {
  const imageBlocks: Anthropic.ContentBlockParam[] = images.map((file) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: file.mimetype as "image/jpeg" | "image/png" | "image/webp",
      data: file.buffer.toString("base64"),
    },
  }));

  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16384,
    tools: [deliveryTool],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [...imageBlocks, { type: "text", text: promptFor(images.length, expectedItems, isPartial) }],
      },
    ],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME
  );
  if (!toolUse) {
    return { isDeliveryPhoto: false, rejectionReason: "Claude couldn't analyze this photo. Please try again.", matches: [] };
  }
  return parseToolResult(toolUse.input as Record<string, unknown>);
}

/**
 * Sends compressed delivery photos to Claude. If a single request is still
 * over Anthropic's 32MB cap (common with 20+ aisle photos), splits the set
 * in half and merges the counts.
 */
async function analyzeBatch(
  images: { buffer: Buffer; mimetype: string }[],
  expectedItems: ExpectedDeliveryItem[],
  isPartial: boolean
): Promise<AnalyzedDeliveryResult> {
  try {
    return await callClaude(images, expectedItems, isPartial);
  } catch (err) {
    if (!isRequestTooLarge(err)) throw err;
    if (images.length === 1) {
      throw new Error(
        "One of the photos is still too large to analyze after compressing. Try a closer shot of a single stack."
      );
    }
    const mid = Math.ceil(images.length / 2);
    const halves = await Promise.all([
      analyzeBatch(images.slice(0, mid), expectedItems, true),
      analyzeBatch(images.slice(mid), expectedItems, true),
    ]);
    return mergeResults(halves, expectedItems);
  }
}

/**
 * Sends one or more delivery photos + the list of items expected per the
 * invoice to Claude, and gets back a per-item match verdict. Flags the
 * upload if none of the photos are usable shots of a physical delivery.
 *
 * Photos are compressed before the Claude call. Large sets (e.g. 21 aisle
 * stacks) are split automatically if they still exceed the API size limit;
 * counts are then summed across batches.
 */
export async function analyzeDeliveryPhoto(
  files: { buffer: Buffer; mimetype: string }[],
  expectedItems: ExpectedDeliveryItem[]
): Promise<AnalyzedDeliveryResult> {
  const compressed = await Promise.all(files.map((file) => compressImageForVision(file)));
  return analyzeBatch(compressed, expectedItems, false);
}
