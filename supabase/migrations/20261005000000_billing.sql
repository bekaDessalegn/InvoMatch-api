-- Subscription mode, scan balances, and platform admins.
--
-- subscription_mode stays off until a platform admin turns it on. While it
-- is off, invoice and delivery scans are not counted and nobody is blocked.
-- Turning it on gives every store that is not already paying 14 days before
-- new scans require a plan.

create table if not exists platform_settings (
  id int primary key default 1 check (id = 1),
  subscription_mode boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into platform_settings (id, subscription_mode)
values (1, false)
on conflict (id) do nothing;

alter table platform_settings enable row level security;

create table if not exists platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table platform_admins enable row level security;

alter table stores add column if not exists stripe_customer_id text;
alter table stores add column if not exists stripe_subscription_id text;
alter table stores add column if not exists grace_until timestamptz;

create table if not exists scan_lots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  source text not null check (source in ('plan', 'topup', 'adjustment')),
  scans_granted int not null check (scans_granted > 0),
  scans_remaining int not null check (scans_remaining >= 0),
  expires_at timestamptz,
  stripe_id text unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_scan_lots_store on scan_lots (store_id);

alter table scan_lots enable row level security;

create table if not exists scan_ledger (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  delta int not null,
  reason text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_scan_ledger_store on scan_ledger (store_id, created_at desc);

alter table scan_ledger enable row level security;

-- Takes one scan from the soonest plan lot, then the soonest top-up.
-- Returns the lot id, or null when the store has nothing left.
create or replace function public.consume_scan(target_store uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  lot uuid;
begin
  select id into lot
  from scan_lots
  where store_id = target_store
    and scans_remaining > 0
    and (expires_at is null or expires_at > now())
  order by case when source = 'plan' then 0 else 1 end,
           expires_at nulls last,
           created_at
  limit 1
  for update;

  if lot is null then
    return null;
  end if;

  update scan_lots
  set scans_remaining = scans_remaining - 1
  where id = lot;

  insert into scan_ledger (store_id, delta, reason)
  values (target_store, -1, 'scan');

  return lot;
end;
$$;

create or replace function public.refund_scan(lot uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_store uuid;
begin
  update scan_lots
  set scans_remaining = scans_remaining + 1
  where id = lot
  returning store_id into target_store;

  if target_store is null then
    return;
  end if;

  insert into scan_ledger (store_id, delta, reason)
  values (target_store, 1, 'refund');
end;
$$;

revoke all on function public.consume_scan(uuid) from public, anon, authenticated;
revoke all on function public.refund_scan(uuid) from public, anon, authenticated;
grant execute on function public.consume_scan(uuid) to service_role;
grant execute on function public.refund_scan(uuid) to service_role;
