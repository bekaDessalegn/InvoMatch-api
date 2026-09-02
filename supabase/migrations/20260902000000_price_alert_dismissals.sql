-- Price alerts are computed on the fly from price_history (see
-- priceAlerts.controller.ts) rather than stored as rows, so "dismissing"
-- one can't just be a status flip on an existing row. Instead we record
-- which (item, vendor, invoice) triggers have been acknowledged; the
-- invoice_id is the specific invoice whose price change caused the alert,
-- so if the price changes again on a *later* invoice, a fresh alert fires
-- even though the item+vendor pair was dismissed before.

create table if not exists price_alert_dismissals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  item_id uuid not null references items (id) on delete cascade,
  vendor_id uuid not null references vendors (id) on delete cascade,
  invoice_id uuid not null references invoices (id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  unique (store_id, item_id, vendor_id, invoice_id)
);

create index if not exists idx_price_alert_dismissals_store_id on price_alert_dismissals (store_id);

alter table price_alert_dismissals enable row level security;

create policy "Store members can select price_alert_dismissals" on price_alert_dismissals
  for select using (store_id in (select current_store_ids()));
create policy "Store members can insert price_alert_dismissals" on price_alert_dismissals
  for insert with check (store_id in (select current_store_ids()));
create policy "Store members can update price_alert_dismissals" on price_alert_dismissals
  for update using (store_id in (select current_store_ids())) with check (store_id in (select current_store_ids()));
create policy "Store members can delete price_alert_dismissals" on price_alert_dismissals
  for delete using (store_id in (select current_store_ids()));
