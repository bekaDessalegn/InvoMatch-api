/** Keeps rows in the order they were inserted (invoice top-to-bottom). */
export function sortByCreatedAt<T extends { created_at?: string | null }>(
  rows: T[] | null | undefined
): T[] {
  return [...(rows ?? [])].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}

export function sortDeliveryLineItems<
  T extends { invoice_line_items?: { created_at?: string | null } | null },
>(rows: T[] | null | undefined): T[] {
  return [...(rows ?? [])].sort((a, b) =>
    String(a.invoice_line_items?.created_at ?? "").localeCompare(String(b.invoice_line_items?.created_at ?? ""))
  );
}
