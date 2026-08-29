-- Store-scoped RLS policies for every tenant table. RLS was already
-- enabled (deny-all) in 20260822000001_enable_rls.sql; this migration adds
-- the actual select/insert/update/delete policies so a user can only ever
-- see or modify rows belonging to a store they're a member of (per
-- current_store_ids(), defined in 20260823000000_stores_and_members.sql).
--
-- The backend uses the service-role key and bypasses RLS entirely, so it
-- remains responsible for enforcing store scoping in application code too
-- (see src/middleware/auth.ts) — these policies are the defense-in-depth
-- layer for any future direct-from-client Supabase access.

do $$
declare
  t text;
begin
  foreach t in array array[
    'vendors',
    'items',
    'vendor_items',
    'invoices',
    'invoice_line_items',
    'price_history',
    'deliveries',
    'delivery_line_items'
  ]
  loop
    execute format(
      'create policy "Store members can select %1$s" on %1$s for select using (store_id in (select current_store_ids()));',
      t
    );
    execute format(
      'create policy "Store members can insert %1$s" on %1$s for insert with check (store_id in (select current_store_ids()));',
      t
    );
    execute format(
      'create policy "Store members can update %1$s" on %1$s for update using (store_id in (select current_store_ids())) with check (store_id in (select current_store_ids()));',
      t
    );
    execute format(
      'create policy "Store members can delete %1$s" on %1$s for delete using (store_id in (select current_store_ids()));',
      t
    );
  end loop;
end $$;
