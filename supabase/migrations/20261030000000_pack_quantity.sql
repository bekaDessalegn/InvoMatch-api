-- Units inside the price on a line (a case of 12 cans is 12). Price alerts
-- divide by this so a single can is not compared with a whole case.
alter table invoice_line_items
  add column if not exists pack_quantity numeric(12, 3)
  check (pack_quantity is null or pack_quantity > 0);

alter table price_history
  add column if not exists pack_quantity numeric(12, 3)
  check (pack_quantity is null or pack_quantity > 0);
