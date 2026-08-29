-- Lets a confirmed invoice keep a reference to the original scanned
-- photo/PDF, mirroring `deliveries.photo_url`. Both columns store a private
-- Supabase Storage *path* (e.g. "storeId/uuid.jpg"), not a public URL — the
-- backend generates short-lived signed URLs on read (see src/services/storage.ts).
alter table invoices add column if not exists photo_url text;

-- Private buckets for original invoice/delivery photos and PDFs. Only the
-- backend (service-role key) ever reads/writes these — no client-facing
-- storage policies are needed since RLS doesn't apply to the service role,
-- and Flutter never talks to Supabase Storage directly.
insert into storage.buckets (id, name, public)
values
  ('invoice-photos', 'invoice-photos', false),
  ('delivery-photos', 'delivery-photos', false)
on conflict (id) do nothing;
