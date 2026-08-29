-- Enable Row Level Security on every table with no policies defined yet.
--
-- The backend (/server) talks to Supabase using the service-role key, which
-- always bypasses RLS — so the API keeps working unchanged. This migration
-- simply ensures that if anon/authenticated keys are ever used directly
-- (e.g. future direct-from-app reads), they see no rows until explicit
-- policies are added.

alter table vendors enable row level security;
alter table items enable row level security;
alter table vendor_items enable row level security;
alter table invoices enable row level security;
alter table invoice_line_items enable row level security;
alter table price_history enable row level security;
alter table deliveries enable row level security;
alter table delivery_line_items enable row level security;
