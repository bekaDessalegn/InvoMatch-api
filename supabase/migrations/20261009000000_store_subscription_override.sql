-- Per-store subscription control for the admin site.
-- null follows the platform switch. 'on' requires a plan for this store.
-- 'off' lets this store scan without a plan.

alter table stores add column if not exists subscription_override text
  check (subscription_override in ('on', 'off'));
