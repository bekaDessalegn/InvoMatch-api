-- Store roles, email invites, and who created each record.
--
-- owner  — the person who created the store. Cannot be removed.
-- admin  — invited, same access as the owner except they cannot remove the owner.
-- worker — sees and edits only records they created (plus catalog rows that
--          came from their invoices).
--
-- Removing a member deletes their membership only. Invoices, deliveries,
-- vendors, and items stay, and user_profiles keeps the name shown on them.

alter table store_members drop constraint if exists store_members_role_check;
update store_members set role = 'worker' where role = 'keeper';
alter table store_members
  add constraint store_members_role_check check (role in ('owner', 'admin', 'worker'));

create table if not exists user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  updated_at timestamptz not null default now()
);

alter table user_profiles enable row level security;

insert into user_profiles (user_id, email, full_name)
select
  u.id,
  coalesce(u.email, ''),
  coalesce(
    nullif(u.raw_user_meta_data->>'full_name', ''),
    split_part(coalesce(u.email, 'member'), '@', 1)
  )
from auth.users u
join store_members m on m.user_id = u.id
on conflict (user_id) do nothing;

create table if not exists store_invites (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'worker')),
  invited_by uuid not null references auth.users (id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_store_invites_pending_email
  on store_invites (store_id, lower(email))
  where accepted_at is null;

create index if not exists idx_store_invites_email on store_invites (lower(email));

alter table store_invites enable row level security;

alter table invoices add column if not exists created_by uuid references auth.users (id) on delete set null;
alter table deliveries add column if not exists created_by uuid references auth.users (id) on delete set null;
alter table vendors add column if not exists created_by uuid references auth.users (id) on delete set null;
alter table items add column if not exists created_by uuid references auth.users (id) on delete set null;

create index if not exists idx_invoices_created_by on invoices (created_by);
create index if not exists idx_deliveries_created_by on deliveries (created_by);
create index if not exists idx_vendors_created_by on vendors (created_by);
create index if not exists idx_items_created_by on items (created_by);

-- Existing rows belong to the store owner so the current account keeps seeing them.
update invoices i
set created_by = m.user_id
from store_members m
where m.store_id = i.store_id and m.role = 'owner' and i.created_by is null;

update deliveries d
set created_by = m.user_id
from store_members m
where m.store_id = d.store_id and m.role = 'owner' and d.created_by is null;

update vendors v
set created_by = m.user_id
from store_members m
where m.store_id = v.store_id and m.role = 'owner' and v.created_by is null;

update items it
set created_by = m.user_id
from store_members m
where m.store_id = it.store_id and m.role = 'owner' and it.created_by is null;

-- Each person dismisses their own alerts, so a worker marking one seen
-- does not hide it from the owner.
alter table price_alert_dismissals
  add column if not exists dismissed_by uuid references auth.users (id) on delete cascade;

update price_alert_dismissals d
set dismissed_by = (
  select m.user_id from store_members m
  where m.store_id = d.store_id and m.role = 'owner'
  limit 1
)
where d.dismissed_by is null;

delete from price_alert_dismissals where dismissed_by is null;

alter table price_alert_dismissals alter column dismissed_by set not null;

alter table price_alert_dismissals
  drop constraint if exists price_alert_dismissals_store_id_item_id_vendor_id_invoice_id_key;

alter table price_alert_dismissals
  drop constraint if exists price_alert_dismissals_user_trigger_key;

alter table price_alert_dismissals
  add constraint price_alert_dismissals_user_trigger_key
  unique (store_id, dismissed_by, item_id, vendor_id, invoice_id);

-- Lets the API check "does this email already belong to a store?" without
-- exposing auth.users to the app. Only the service role may call it.
create or replace function public.user_id_by_email(lookup text)
returns uuid
language sql
security definer
stable
set search_path = auth, public
as $$
  select id from auth.users where lower(email) = lower(lookup) limit 1;
$$;

revoke all on function public.user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.user_id_by_email(text) to service_role;
