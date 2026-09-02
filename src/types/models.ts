/**
 * TypeScript interfaces mirroring the Supabase schema defined in
 * /server/supabase/migrations. Keep these in sync with the SQL migrations.
 */

export type SubscriptionStatus = "trial" | "active" | "past_due" | "canceled";
export type StoreRole = "owner" | "keeper";

export type VendorStatus = "active" | "inactive";
export type InvoiceSourceType = "photo" | "pdf";
export type InvoiceStatus = "draft" | "confirmed";
export type DeliveryStatus = "pending" | "verified" | "discrepancy";
export type MatchStatus = "matched" | "needs_review" | "missing";

export interface Store {
  id: string;
  name: string;
  subscription_status: SubscriptionStatus;
  subscription_plan: string | null;
  created_at: string;
}

export interface StoreMember {
  id: string;
  store_id: string;
  user_id: string;
  role: StoreRole;
  created_at: string;
}

export interface Vendor {
  id: string;
  store_id: string;
  name: string;
  contact_info: string | null;
  payment_terms: string | null;
  status: VendorStatus;
  created_at: string;
}

export interface Item {
  id: string;
  store_id: string;
  canonical_name: string;
  category: string | null;
  created_at: string;
}

export interface VendorItem {
  id: string;
  store_id: string;
  vendor_id: string;
  item_id: string;
  vendor_sku: string | null;
  vendor_description: string;
}

export interface Invoice {
  id: string;
  store_id: string;
  vendor_id: string;
  invoice_number: string;
  invoice_date: string;
  source_type: InvoiceSourceType;
  status: InvoiceStatus;
  subtotal: number;
  tax: number;
  total: number;
  photo_paths: string[];
  created_at: string;
}

export interface InvoiceLineItem {
  id: string;
  store_id: string;
  invoice_id: string;
  vendor_item_id: string | null;
  raw_name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface PriceHistory {
  id: string;
  store_id: string;
  item_id: string;
  vendor_id: string;
  invoice_id: string;
  price: number;
  recorded_at: string;
}

export interface Delivery {
  id: string;
  store_id: string;
  invoice_id: string;
  photo_paths: string[];
  status: DeliveryStatus;
  created_at: string;
}

export interface DeliveryLineItem {
  id: string;
  store_id: string;
  delivery_id: string;
  invoice_line_item_id: string;
  detected_quantity: number | null;
  confirmed_quantity: number | null;
  match_status: MatchStatus;
  created_at: string;
}
