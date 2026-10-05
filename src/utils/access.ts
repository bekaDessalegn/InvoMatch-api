import type { Request } from "express";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";

export type StoreRole = "owner" | "admin" | "worker";

export function isManager(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Workers are limited to rows they created. Owners and admins are not. */
export function creatorScope(req: Request): string | undefined {
  return isManager(req.storeRole) ? undefined : req.userId;
}

export function assertCanEdit(req: Request, createdBy: string | null | undefined): void {
  if (isManager(req.storeRole)) return;
  if (!createdBy || createdBy !== req.userId) {
    throw new ApiError(403, "You can only change records you created");
  }
}

export async function ownedInvoiceIds(storeId: string, userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select("id")
    .eq("store_id", storeId)
    .eq("created_by", userId);
  if (error) throw new ApiError(500, error.message);
  return (data ?? []).map((row) => row.id as string);
}

/** Vendors this worker created, plus vendors that appear on their invoices. */
export async function visibleVendorIds(storeId: string, userId: string): Promise<string[]> {
  const [{ data: own, error: ownError }, { data: invoices, error: invoiceError }] = await Promise.all([
    supabase.from("vendors").select("id").eq("store_id", storeId).eq("created_by", userId),
    supabase.from("invoices").select("vendor_id").eq("store_id", storeId).eq("created_by", userId),
  ]);
  if (ownError) throw new ApiError(500, ownError.message);
  if (invoiceError) throw new ApiError(500, invoiceError.message);
  return [
    ...new Set([
      ...(own ?? []).map((row) => row.id as string),
      ...(invoices ?? []).map((row) => row.vendor_id as string),
    ]),
  ];
}

/** Items this worker created, plus items that appear on their invoices. */
export async function visibleItemIds(storeId: string, userId: string): Promise<string[]> {
  const [{ data: own, error: ownError }, { data: lines, error: linesError }] = await Promise.all([
    supabase.from("items").select("id").eq("store_id", storeId).eq("created_by", userId),
    supabase
      .from("invoice_line_items")
      .select("vendor_item_id, invoices!inner(created_by)")
      .eq("store_id", storeId)
      .eq("invoices.created_by", userId),
  ]);
  if (ownError) throw new ApiError(500, ownError.message);
  if (linesError) throw new ApiError(500, linesError.message);

  const vendorItemIds = [
    ...new Set(
      (lines ?? [])
        .map((row) => row.vendor_item_id as string | null)
        .filter((id): id is string => !!id)
    ),
  ];

  let linked: string[] = [];
  if (vendorItemIds.length > 0) {
    const { data, error } = await supabase.from("vendor_items").select("item_id").in("id", vendorItemIds);
    if (error) throw new ApiError(500, error.message);
    linked = (data ?? []).map((row) => row.item_id as string);
  }

  return [...new Set([...(own ?? []).map((row) => row.id as string), ...linked])];
}

export async function creatorNameMap(userIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase.from("user_profiles").select("user_id, full_name, email").in("user_id", ids);
  if (error) throw new ApiError(500, error.message);

  return new Map(
    (data ?? []).map((row) => [row.user_id as string, (row.full_name as string) || (row.email as string)])
  );
}

export async function withCreatorNames<T extends { created_by?: string | null }>(
  rows: T[]
): Promise<(T & { created_by_name: string | null })[]> {
  const names = await creatorNameMap(rows.map((row) => row.created_by));
  return rows.map((row) => ({
    ...row,
    created_by_name: row.created_by ? names.get(row.created_by) ?? null : null,
  }));
}

export async function upsertProfile(userId: string, email: string, fullName: string): Promise<void> {
  const { error } = await supabase.from("user_profiles").upsert(
    {
      user_id: userId,
      email: email.toLowerCase(),
      full_name: fullName.trim(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw new ApiError(500, error.message);
}
