-- One row per feed item this plugin has turned into a signal, per feed and
-- record: a re-poll finds the row and emits nothing. `signal_id` stays null
-- until the signal is written, so an item whose emit failed is retried.
create table feed_item (
  id bigserial primary key,
  feed_url text not null,
  record_id uuid not null,
  item_key text not null,
  title text,
  url text,
  published_at timestamptz,
  signal_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create unique index feed_item_key on feed_item (feed_url, record_id, item_key);
