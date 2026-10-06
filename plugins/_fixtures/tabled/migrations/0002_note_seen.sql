alter table note add column seen_at timestamptz not null default now();
create index note_entity_id on note (entity_id);
