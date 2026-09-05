# Survey: Attio's attribute & custom-object model

Method: live dump of a fresh Attio Pro trial workspace via the REST API
(2026-09-01), plus creation probes — a custom object (`test_widgets`), a list
(`test_pipeline`), one attribute per type, and records exercising every
writable value shape. Everything below is observed API behavior, not docs
paraphrase. Raw JSON captures live in the session scratchpad (`attio/`).

## 1. Core model

Four layers:

1. **Objects** — schemas. Standard objects (`people`, `companies`, `deals`;
   `users`/`workspaces` exist in the product but aren't enabled by default in
   a fresh workspace) plus user-created custom objects
   (`POST /v2/objects {api_slug, singular_noun, plural_noun}`).
2. **Attributes** — typed fields on an object _or on a list_. Same attribute
   machinery serves both; the API path differs
   (`/objects/{o}/attributes` vs `/lists/{l}/attributes`).
3. **Lists** — curated subsets of one parent object's records. An entry
   carries its own list-scoped attribute values (e.g. pipeline stage lives on
   the list entry, not the record). New lists get only `entry_id`,
   `created_at`, `created_by` — stage/status is an ordinary attribute you add.
4. **Records / entries** — the data. Values are keyed by attribute slug.

### Values are temporal lists, not scalars

The single biggest structural fact: every attribute value on a record is an
**array of value objects**, each stamped with:

```json
{
  "active_from": "2026-09-01T14:17:26.744Z",
  "active_until": null,
  "created_by_actor": { "type": "api-token", "id": "…" },
  "attribute_type": "text",
  "value": "hello world"
}
```

- Current value = entries where `active_until == null`.
- History is retained: overwriting closes the old entry (`active_until` set)
  and appends a new one. Full audit/provenance for free.
- Multiselect is the same array with multiple active entries.
- `created_by_actor` types observed: `api-token`, `workspace-member`, plus
  `system` for computed values.

## 2. Attribute metadata schema

Every attribute (object- or list-level) has:

| Field                                        | Notes                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `id`                                         | `{workspace_id, object_id, attribute_id}` composite                                           |
| `title`, `description`, `api_slug`           | slug unique per parent                                                                        |
| `type`                                       | one of 17 types (§3)                                                                          |
| `is_system_attribute`                        | seeded by Attio; user attrs get `false`                                                       |
| `is_writable`                                | `false` for computed/system fields (`record_id`, interactions, enrichment)                    |
| `is_required`                                | e.g. deal `name`, `stage`, `owner`                                                            |
| `is_unique`                                  | e.g. `record_id`, people `email_addresses`, company `domains`                                 |
| `is_multiselect`                             | multi is a _flag_, not a separate type — any select/reference/email/phone/domain can be multi |
| `is_default_value_enabled` + `default_value` | §6                                                                                            |
| `is_archived`                                | soft delete; attributes are archived, never dropped                                           |
| `relationship`                               | two-way link metadata or `null` (§5)                                                          |
| `config`                                     | sparse per-type config (§4)                                                                   |
| `created_at`                                 |                                                                                               |

Notable: **no per-attribute display config in the API** (colors, icons, column
widths live elsewhere/UI-side), and no sort-order field — ordering is a
view/UI concern.

## 3. Type catalog (17 types)

Probed by creating one attribute of each type on a custom object:

| Type               | User-creatable?                      | Write shape                                                                                           | Read shape (inside value object)                                                      |
| ------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `text`             | ✅                                   | `"hello"`                                                                                             | `value: string`                                                                       |
| `number`           | ✅                                   | `42.5`                                                                                                | `value: number`                                                                       |
| `checkbox`         | ✅                                   | `true`                                                                                                | `value: boolean`                                                                      |
| `currency`         | ✅                                   | `123456.78`                                                                                           | `currency_code: "USD"`, `currency_value: number`                                      |
| `date`             | ✅                                   | `"2026-09-01"`                                                                                        | `value: "YYYY-MM-DD"`                                                                 |
| `timestamp`        | ✅                                   | ISO 8601                                                                                              | `value` normalized to ns-precision UTC                                                |
| `rating`           | ✅                                   | int `0–5` (11 rejected)                                                                               | `value: number`                                                                       |
| `status`           | ✅                                   | status title or id                                                                                    | embedded full status object                                                           |
| `select`           | ✅                                   | option title or id                                                                                    | embedded full option object                                                           |
| `record-reference` | ✅ (config or relationship required) | `{target_object, target_record_id}`                                                                   | same                                                                                  |
| `actor-reference`  | ✅                                   | `{referenced_actor_type: "workspace-member", referenced_actor_id}`                                    | same                                                                                  |
| `location`         | ✅                                   | full object required: `line_1..line_4, locality, region, postcode, country_code, latitude, longitude` | same, single composite value                                                          |
| `phone-number`     | ✅                                   | `{original_phone_number: "+1…"}`                                                                      | adds derived `phone_number`, `country_code`                                           |
| `domain`           | ❌ "not yet supported"               | `{domain}` (on system attrs)                                                                          | adds derived `root_domain`; validator checks real TLD (`.example` rejected)           |
| `email-address`    | ❌ "not yet supported"               | `"jane@x.com"`                                                                                        | derived `email_address`, `email_domain`, `email_root_domain`, `email_local_specifier` |
| `personal-name`    | ❌ system-only                       | `{first_name, last_name, full_name}`                                                                  | same                                                                                  |
| `interaction`      | ❌ system-only                       | not writable                                                                                          | computed from email/calendar sync: `{interaction_type, interacted_at, owner_actor}`   |

Pattern worth stealing: writes accept **shorthand** (bare string/number,
option title), reads return **normalized enriched objects** (parsed phone
country, email domain parts, embedded option). Ingestion is forgiving, output
is canonical.

## 4. Config model

`config` is nearly empty — only two type-specific blocks exist, and every
attribute carries both keys (nulled when irrelevant):

```json
"config": {
  "currency": { "default_currency_code": "USD", "display_type": "symbol" },
  "record_reference": { "allowed_object_ids": ["uuid", …] | null }
}
```

- `currency` config is _required_ at creation for currency attrs
  (`display_type`: `symbol` | `code` | `name`).
- `record_reference.allowed_objects` (slugs accepted on write, ids on read)
  restricts targets; `null` = any object.
- Rating has **no max config** — hardcoded 0–5. Select options and statuses
  are sub-resources, not config (§5).

## 5. Options, statuses, relationships

**Select options** — `POST/GET/PATCH /…/attributes/{a}/options`.
Shape: `{id{…option_id}, title, is_archived}`. No color, no group in the API.
Archived, never deleted (values may reference them).

**Statuses** — same pattern at `/statuses`, richer shape:
`{title, is_archived, target_time_in_status: "P7D" (ISO duration), celebration_enabled}`.
A status attribute is created empty — no default statuses. Deals ship with
`Lead`, `In Progress`, `Won 🎉`, `Lost`. No explicit active/closed grouping
field — funnel semantics are positional/UI-side.

**Relationships (two-way references)** — a `record-reference` created with a
`relationship` block auto-creates the mirror attribute on the target object:

```json
"relationship": { "object": "companies", "api_slug": "test_widgets_rel",
                  "title": "Widgets", "is_multiselect": true }
```

Both sides stay in sync (people `company` ↔ companies `team`,
deals `associated_company` ↔ companies `associated_deals` are built this way).
One-way refs (`config.record_reference` only) also exist.

## 6. Default values

```json
"default_value": { "type": "static" | "dynamic", "template": … }
```

- **Dynamic** templates are strings; only two families supported:
  `"current-user"` (actor-reference) and ISO durations for date/timestamp —
  `"PT0S"` = now (used by `created_at`), `"P1W"` = a week out.
- **Static** takes an array of value objects matching the type's write shape,
  e.g. `[{"value": "hello"}]` (the server stamps `attribute_type` in). Probed:
  static defaults are **rejected on object attributes** ("Default values are
  not currently supported on objects") but **work on list attributes** — the
  create-dialog default field for objects must ride a newer private API.

## 7. Standard-object inventories

New custom objects seed only `record_id`, `created_at`, `created_by`.

### Deals (9) — deliberately minimal

| Slug                        | Type             | Flags                                            |
| --------------------------- | ---------------- | ------------------------------------------------ |
| `record_id`                 | text             | system, unique, read-only                        |
| `name`                      | text             | **required**                                     |
| `stage`                     | status           | **required**; Lead / In Progress / Won 🎉 / Lost |
| `owner`                     | actor-reference  | **required**                                     |
| `value`                     | currency         | USD                                              |
| `associated_people`         | record-reference | multi, two-way ↔ people                          |
| `associated_company`        | record-reference | single, two-way ↔ companies                      |
| `created_at` / `created_by` |                  | dynamic defaults `PT0S` / `current-user`         |

### People (29)

Identity: `name` (personal-name), `email_addresses` (email, multi, **unique**),
`avatar_url` (read-only). Profile: `description`, `job_title`,
`primary_location` (location), `phone_numbers` (multi). Socials as plain text:
`angellist`, `facebook`, `instagram`, `linkedin`, `twitter`,
`twitter_follower_count` (number, read-only enrichment). Links: `company`
(single ref ↔ companies `team`), `associated_deals` (multi ref).
Computed (all read-only): 8 `interaction` attrs — first/last/next ×
calendar/email/any — plus `strongest_connection_strength` (select: Very weak →
Very strong), `strongest_connection_user` (actor-ref),
`strongest_connection_strength_legacy` (number).

### Companies (32)

Identity: `domains` (domain, multi, **unique** — the dedupe key), `name`,
`logo_url` (read-only). Profile: `description`, `primary_location`,
`foundation_date` (date), socials (same six as people). Enrichment selects:
`categories` (multi, 152 options: 3D Printing … Accounting … Aerospace),
`estimated_arr_usd` (9 banded options `$0-$1M` … `$10B+`),
`employee_range` (9 bands `1-10` … `100K+`), `funding_raised_usd` (currency).
Links: `team` (multi ↔ people `company`), `associated_deals`. Same 11
computed interaction/connection attrs as people.

Notable: ARR and employee count are **banded selects**, not numbers —
enrichment data is fuzzy, bands admit that. Socials are text, not a URL type
(no URL type exists; validation is per-slug UI concern).

## 8. Delta vs. dealos registry

Where we already match: fixed type menu users pick from; select/status options
as data with archive semantics; system-vs-user attribute flag; seeded
per-object system attributes; status groups on deal stage.

| Attio                                                                      | Us                              | Assessment                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Values = temporal arrays w/ `active_from`/`active_until`/actor             | scalar EAV                      | Biggest gap. Gives value history, provenance, painless multi. Consider before the value store ossifies — retrofit is a rewrite.                             |
| `is_multiselect` a flag on any type                                        | `multi_select` as separate type | Flag composes (multi email, multi ref, multi domain); separate type doesn't. We already do `multi` for record_reference — inconsistent.                     |
| Two-way `relationship` refs, auto mirror attr                              | one-way `record_reference`      | Mirror attr = reverse lookup is schema, not query convention. Worth it if custom objects land.                                                              |
| Attributes on **lists** too                                                | object attrs only               | Their stage-on-entry lets one record sit in N pipelines. Our deals are the pipeline; fine until multi-pipeline.                                             |
| Composite value objects (location, personal-name, phone w/ derived fields) | flat strings                    | Their normalize-on-write (email→domain parts, phone→country) enables dedupe/joins. Relevant to our dedupe page.                                             |
| Statuses carry `target_time_in_status`, `celebration_enabled`              | `group` + `color`               | Ours is honestly better for funnel semantics (their grouping is implicit). Time-in-stage targets are a nice pipeline-hygiene idea.                          |
| Options: no color/group in API                                             | color + group on options        | Ours richer; theirs UI-side. Keep ours.                                                                                                                     |
| Banded enrichment selects (ARR, headcount)                                 | —                               | Good pattern for fuzzy third-party data if enrichment ever lands.                                                                                           |
| `rating` hardcoded 0–5, no config                                          | configurable max                | Ours superset.                                                                                                                                              |
| No `url` type (socials are text)                                           | `url` type                      | Ours stricter; fine.                                                                                                                                        |
| Default-value model (`static`/`dynamic`, `current-user`, ISO durations)    | —                               | Cheap to add; `current-user` owner default is immediately useful.                                                                                           |
| Custom objects (`POST /objects`)                                           | fixed 3 kinds                   | The headline feature this survey informs. Their recipe: object = slug+nouns, seed 3 system attrs, everything else user attrs, refs via relationship blocks. |

## 9. UI layer (browser pass, 2026-09-01)

Walked the real "Create attribute" dialog for every type. The API is the data
schema only — the UI carries a second layer it never exposes:

**Hidden from the API entirely:**

- Two extra system attrs on every object: `List entries` and `Next due task`
  (both type "Record") — absent from `/attributes` responses.
- **Formula type.** Dialog = Name + formula builder + Description (no
  constraints/default). The builder has a code editor, an **AI prompt bar**
  ("Describe the formula you want Attio to create…"), an output-type dropdown
  (Auto), and an attribute browser that traverses references cross-object
  (`Created by →`, 2–3 levels deep).
- **AI autofill "types"** in the type menu: Classify record, Prompt
  completion, Summarize record, Web agent — enrichment recipes presented as
  attribute types.
- **Number display config**: Decimal places (0–4) + Grouping — despite the
  API returning empty `config` for number.
- Object-level UI: 4/12 custom-object cap, per-object tabs (Configuration /
  Permissions / Appearance / Attributes / Templates), Users & Workspaces
  objects behind an "Activate" toggle.

**Dialog anatomy** — one morphing dialog, fixed header (Type ▾ / Name /
Description), then per-type slots. No slug field anywhere (auto-derived,
hidden). Footer: Cancel ESC / Create ⌘↵.

| Type             | Type-specific UI                                                                                                                                                                                             | Default value                | Constraints shown                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------ |
| Text             | —                                                                                                                                                                                                            | text input                   | Required, Unique                           |
| Number           | Decimal places, Grouping                                                                                                                                                                                     | — (none!)                    | — (none)                                   |
| Checkbox         | —                                                                                                                                                                                                            | checkbox widget              | Required, Unique (uniform, even where odd) |
| Currency         | Currency (req) + Display (req) dropdowns                                                                                                                                                                     | value input                  | Required, Unique                           |
| Date / Timestamp | —                                                                                                                                                                                                            | date/ts picker               | Required, Unique                           |
| Rating           | —                                                                                                                                                                                                            | 5-star widget (fixed scale)  | Required, Unique                           |
| Location         | —                                                                                                                                                                                                            | "Set a default"              | Required, Unique                           |
| Phone Number     | —                                                                                                                                                                                                            | value input                  | Required, Unique, **Multiple values**      |
| Select           | Options editor (inline "+ Create option")                                                                                                                                                                    | option picker                | Required only                              |
| Multi-select     | same Options editor                                                                                                                                                                                          | multi option picker          | Required only                              |
| Status           | Stages editor ("No stages")                                                                                                                                                                                  | default stage                | Required, Unique                           |
| Record           | "Available object types" multi-picker                                                                                                                                                                        | disabled until object chosen | Required, Unique                           |
| User             | —                                                                                                                                                                                                            | user picker                  | Required, Unique, **Multiple values**      |
| Relationship     | **Different dialog**: two-panel configurator (this object ↔ target), per-side attribute names, cardinality dropdown (one-to-one / one-to-many / many-to-one / many-to-many) with live diagram + example copy | —                            | —                                          |
| Formula          | formula builder (see above)                                                                                                                                                                                  | —                            | —                                          |

UI language vs API: Record = one-way `record-reference`; Relationship =
`record-reference` + `relationship` (cardinality ⇒ the two `is_multiselect`
flags); User = `actor-reference`; stages = statuses. "Multiple values" is a
constraints-checkbox on multi-capable scalar types, while select vs
multi-select are presented as distinct types — the API's uniform
`is_multiselect` flag is deliberately re-skinned per type family.

Takeaways for our dialog: type-first morphing dialog confirmed; suppress
nothing uniformly (Attio shows Required/Unique even on checkbox — uniformity
over per-type fussiness); default-value slot is per-type widget, not a text
field; relationship deserves its own dialog, not a slot.

## 10. Lifecycle & entry semantics (probed 2026-09-02)

**Attribute lifecycle:**

- `type` is **immutable** — PATCH with `type` rejected ("Unrecognized key").
  No text→number conversions, ever. Type choice is permanent; migration =
  new attribute + data copy.
- `title` rename leaves `api_slug` untouched; `api_slug` itself IS mutable
  via PATCH (an integration-breaking footgun they allow).
- Archive (`is_archived: true`) **hides the attribute's values from record
  reads entirely** (key absent); unarchive restores them intact — the
  temporal store keeps everything.
- No DELETE endpoint for attributes. Archive-only, confirmed.

**Select option archive** mirrors this exactly: archiving an option hides
existing values from reads (empty array, not a tombstone) and blocks new
writes ("Cannot find select option"); unarchive restores. Values are never
rewritten — visibility is filtered at read time.

**List entries:**

- Entry = `{entry_id, parent_record_id, parent_object, entry_values}`;
  entry_values use the same temporal value-object shape as records.
- **The same record can be added to the same list multiple times** — two
  entries, independent stages. Entries are instances, not memberships.
  (Fits their model — a company can be in one pipeline twice for two
  separate rounds; decide deliberately whether we want that.)

Design consequences for us: enforce type-immutability from day one (cheap
now, impossible later); slug immutable (do better than Attio); archive-only
lifecycle with read-time filtering for both attributes and options.

Test residue left in the trial workspace: `test_widgets` object (objects
can't be deleted via API), `Test Pipeline` list, records "RefCo" and
"Jane Doe", probe attributes (archivable). Harmless; expires with trial.
