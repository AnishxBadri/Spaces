-- The plugin's own table; an FK into core is allowed, never the reverse.
create table note (
  id serial primary key,
  entity_id uuid not null references public.entity (id) on delete cascade,
  body text not null
);
