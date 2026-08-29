-- InvoMatch initial schema
-- Vendors -> Items (canonical catalog) -> Vendor-specific naming/SKUs ->
-- Invoices -> Invoice line items -> Price history, and
-- Invoices -> Deliveries -> Delivery line items (photo-vs-invoice matching).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- vendors
-- ---------------------------------------------------------------------------
create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_info text,
  payment_terms text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- items — the normalized product catalog, independent of any one vendor's
-- naming/SKU conventions.
-- ---------------------------------------------------------------------------
create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  category text,
  created_at timestamptz not null default now()
);

create index if not exists idx_items_category on items (category);

-- ---------------------------------------------------------------------------
-- vendor_items — links a vendor's own naming/SKU to a canonical item.
-- ---------------------------------------------------------------------------
create table if not exists vendor_items (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors (id) on delete cascade,
  item_id uuid not null references items (id) on delete cascade,
  vendor_sku text,
  vendor_description text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_vendor_items_vendor_id on vendor_items (vendor_id);
create index if not exists idx_vendor_items_item_id on vendor_items (item_id);
create unique index if not exists uq_vendor_items_vendor_sku
  on vendor_items (vendor_id, vendor_sku)
  where vendor_sku is not null;

-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors (id) on delete restrict,
  invoice_number text not null,
  invoice_date date not null,
  source_type text not null check (source_type in ('photo', 'pdf')),
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  subtotal numeric(12, 2) not null default 0,
  tax numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_invoices_vendor_id on invoices (vendor_id);
create index if not exists idx_invoices_status on invoices (status);
create index if not exists idx_invoices_invoice_date on invoices (invoice_date);

-- ---------------------------------------------------------------------------
-- invoice_line_items
-- ---------------------------------------------------------------------------
create table if not exists invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id) on delete cascade,
  -- Nullable: a line may not yet be matched to a catalog item.
  vendor_item_id uuid references vendor_items (id) on delete set null,
  raw_name text not null,
  quantity numeric(12, 3) not null,
  unit_price numeric(12, 2) not null,
  total_price numeric(12, 2) not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_invoice_line_items_invoice_id on invoice_line_items (invoice_id);
create index if not exists idx_invoice_line_items_vendor_item_id on invoice_line_items (vendor_item_id);

-- ---------------------------------------------------------------------------
-- price_history — one row per time a price was seen for an item from a
-- vendor; used to compute increase/decrease alerts.
-- ---------------------------------------------------------------------------
create table if not exists price_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items (id) on delete cascade,
  vendor_id uuid not null references vendors (id) on delete cascade,
  invoice_id uuid not null references invoices (id) on delete cascade,
  price numeric(12, 2) not null,
  recorded_at timestamptz not null default now()
);

create index if not exists idx_price_history_item_id on price_history (item_id);
create index if not exists idx_price_history_vendor_id on price_history (vendor_id);
create index if not exists idx_price_history_invoice_id on price_history (invoice_id);
-- Powers "latest price for item X from vendor Y" lookups used by the
-- price-comparison alerts feature.
create index if not exists idx_price_history_item_vendor_recorded
  on price_history (item_id, vendor_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- deliveries
-- ---------------------------------------------------------------------------
create table if not exists deliveries (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id) on delete cascade,
  photo_url text,
  status text not null default 'pending' check (status in ('pending', 'verified', 'discrepancy')),
  created_at timestamptz not null default now()
);

create index if not exists idx_deliveries_invoice_id on deliveries (invoice_id);
create index if not exists idx_deliveries_status on deliveries (status);

-- ---------------------------------------------------------------------------
-- delivery_line_items
-- ---------------------------------------------------------------------------
create table if not exists delivery_line_items (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries (id) on delete cascade,
  invoice_line_item_id uuid not null references invoice_line_items (id) on delete cascade,
  detected_quantity numeric(12, 3),
  confirmed_quantity numeric(12, 3),
  match_status text not null default 'needs_review' check (match_status in ('matched', 'needs_review', 'missing')),
  created_at timestamptz not null default now()
);

create index if not exists idx_delivery_line_items_delivery_id on delivery_line_items (delivery_id);
create index if not exists idx_delivery_line_items_invoice_line_item_id on delivery_line_items (invoice_line_item_id);
