-- One target profit margin for the whole store, as a percent of the
-- shelf price. 30 means a $10 cost suggests $14.29. Null until the owner
-- sets it. Invited staff inherit whatever the store already has.

alter table stores add column if not exists target_margin_percent double precision
  check (target_margin_percent > 0 and target_margin_percent < 100);
