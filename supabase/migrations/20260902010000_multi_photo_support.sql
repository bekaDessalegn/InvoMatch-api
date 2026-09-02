-- A single invoice photo isn't enough for a long, multi-page receipt, and a
-- single delivery photo isn't enough to cover a big delivery with many
-- boxes. Both `invoices` and `deliveries` move from one `photo_url` to an
-- ordered array of storage paths, `photo_paths`.

alter table invoices add column if not exists photo_paths text[] not null default '{}';
update invoices set photo_paths = array[photo_url] where photo_url is not null and photo_paths = '{}';
alter table invoices drop column if exists photo_url;

alter table deliveries add column if not exists photo_paths text[] not null default '{}';
update deliveries set photo_paths = array[photo_url] where photo_url is not null and photo_paths = '{}';
alter table deliveries drop column if exists photo_url;
