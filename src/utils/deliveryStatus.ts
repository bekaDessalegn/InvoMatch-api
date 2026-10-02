export type DeliveryLineForStatus = {
  confirmed_quantity?: number | null;
  invoice_line_items?: { quantity?: number | null } | { quantity?: number | null }[] | null;
};

export type DeliveryOverallStatus = "pending" | "verified" | "discrepancy";

function expectedQuantity(line: DeliveryLineForStatus): number | null {
  const nested = line.invoice_line_items;
  const row = Array.isArray(nested) ? nested[0] : nested;
  if (row?.quantity == null) return null;
  return Number(row.quantity);
}

/** Same rule as the app: equal quantities are a match, zero received is missing. */
export function matchStatusForQuantity(
  expected: number,
  confirmed: number | null | undefined
): "matched" | "needs_review" | "missing" {
  if (confirmed != null && Math.abs(Number(confirmed) - expected) < 0.001) return "matched";
  if (confirmed == null || Number(confirmed) <= 0) return "missing";
  return "needs_review";
}

/**
 * Parent delivery status from the corrected quantities, not the status that
 * was stored when the photos were first analyzed.
 */
export function rollupDeliveryStatus(
  lines: DeliveryLineForStatus[] | null | undefined,
  fallback: string
): DeliveryOverallStatus {
  if (!lines || lines.length === 0) {
    if (fallback === "verified" || fallback === "discrepancy" || fallback === "pending") return fallback;
    return "pending";
  }

  const statuses = lines.map((line) => {
    const expected = expectedQuantity(line);
    if (expected == null) return "needs_review" as const;
    return matchStatusForQuantity(expected, line.confirmed_quantity);
  });

  if (statuses.includes("missing")) return "discrepancy";
  if (statuses.every((status) => status === "matched")) return "verified";
  return "pending";
}
