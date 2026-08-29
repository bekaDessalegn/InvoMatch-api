-- Multi-tenancy foundation: stores (the tenant/subscriber) and store_members
-- (links a Supabase Auth user to a store with a role). Every other table
-- will be scoped to a store_id in the next migration.

-- ---------------------------------------------------------------------------
-- stores
-- ---------------------------------------------------------------------------
create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subscription_status text not null default 'trial'
    check (subscription_status in ('trial', 'active', 'past_due', 'canceled')),
  -- Nullable placeholder for future billing integration (e.g. Stripe price/plan id).
  subscription_plan text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- store_members — links auth.users to a store. One store per user for now
-- (enforced by the unique index below); revisit if multi-store membership
-- is needed later.
-- ---------------------------------------------------------------------------
create table if not exists store_members (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'keeper')),
  created_at timestamptz not null default now()
);

create index if not exists idx_store_members_store_id on store_members (store_id);
create unique index if not exists uq_store_members_user_id on store_members (user_id);

-- ---------------------------------------------------------------------------
-- Helper function used by RLS policies (here and on every store-scoped
-- table) to answer "which store(s) does the current JWT's user belong to?"
--
-- SECURITY DEFINER + a fixed search_path lets this function read
-- store_members even though store_members itself has RLS enabled — without
-- this, a policy on store_members that calls this function would recurse.
-- ---------------------------------------------------------------------------
create or replace function public.current_store_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select store_id from store_members where user_id = auth.uid();
$$;

grant execute on function public.current_store_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- RLS — the backend talks to Supabase with the service-role key (which
-- bypasses RLS) and is responsible for all writes to stores/store_members
-- (store creation, membership creation on sign-up). Authenticated clients
-- using the anon/authenticated key can only ever read their own store /
-- roster, never write directly.
-- ---------------------------------------------------------------------------
alter table stores enable row level security;
alter table store_members enable row level security;

create policy "Members can view their own store" on stores
  for select
  using (id in (select current_store_ids()));

create policy "Members can view their store roster" on store_members
  for select
  using (store_id in (select current_store_ids()));
