-- Scope every existing table to a store (tenant). Added as a nullable
-- column first, then flipped to NOT NULL — if this fails with a not-null
-- violation, it means one of these tables already has rows with no store
-- to backfill to; truncate the table (this is expected to be empty in a
-- fresh dev project) or backfill store_id manually before re-running.

alter table vendors add column if not exists store_id uuid references stores (id) on delete cascade;
alter table items add column if not exists store_id uuid references stores (id) on delete cascade;
alter table vendor_items add column if not exists store_id uuid references stores (id) on delete cascade;
alter table invoices add column if not exists store_id uuid references stores (id) on delete cascade;
alter table invoice_line_items add column if not exists store_id uuid references stores (id) on delete cascade;
alter table price_history add column if not exists store_id uuid references stores (id) on delete cascade;
alter table deliveries add column if not exists store_id uuid references stores (id) on delete cascade;
alter table delivery_line_items add column if not exists store_id uuid references stores (id) on delete cascade;

alter table vendors alter column store_id set not null;
alter table items alter column store_id set not null;
alter table vendor_items alter column store_id set not null;
alter table invoices alter column store_id set not null;
alter table invoice_line_items alter column store_id set not null;
alter table price_history alter column store_id set not null;
alter table deliveries alter column store_id set not null;
alter table delivery_line_items alter column store_id set not null;

create index if not exists idx_vendors_store_id on vendors (store_id);
create index if not exists idx_items_store_id on items (store_id);
create index if not exists idx_vendor_items_store_id on vendor_items (store_id);
create index if not exists idx_invoices_store_id on invoices (store_id);
create index if not exists idx_invoice_line_items_store_id on invoice_line_items (store_id);
create index if not exists idx_price_history_store_id on price_history (store_id);
create index if not exists idx_deliveries_store_id on deliveries (store_id);
create index if not exists idx_delivery_line_items_store_id on delivery_line_items (store_id);
