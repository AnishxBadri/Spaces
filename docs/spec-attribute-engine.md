# Spec: the attribute engine (custom-attribute layer)

Consolidates the CONTEXT.md "Attribute engine" decisions with the Attio study
(`survey-attio-attribute-model.md`, API + UI + lifecycle probes, 2026-09).
This is the buildable spec: what exists, what the study changes, exact dialog
and lifecycle contracts.

**Scope boundary (amended 2026-09-02, grilled):** two-tier object model.
Custom _attributes_ apply to every object; custom _objects_ exist as a
second tier — attribute bags inside the entity graph, never carrying the
core machinery (see §10). Notes/spaces/terms stay research-layer, not
object-modeled.

## 1. Storage (exists, confirmed by the study)

```
attribute(id, object_kind, slug, name, type, options jsonb,
          is_system, archived, sort_order, created_by, created_at)
attribute_event(id, entity_id, attr_slug, from, to, actor_id, at)
entity.values jsonb  — all values, keyed by slug
```

**Deliberate divergence from Attio — scalar values + event log, not temporal
arrays.** Attio stores every value as an array of
`{active_from, active_until, created_by_actor, …}` objects; history and
provenance live inside the value store. We keep scalar values in
`entity.values` and write `attribute_event` in the same transaction — same
information (history, provenance, time-in-stage), simpler read path, and the
event log is already load-bearing (stage analytics, machine-write audit,
future formula history functions per the 2026-08 survey). Not revisiting.

## 2. Type menu (exists — 15 types, frozen shape)

text · number · currency · date · checkbox · select · multi_select · status ·
domain · email · url · phone · rating · record_reference · actor_reference

Mapping notes vs Attio:

- **multi is a type (`multi_select`) + a flag (`record_reference.multi`)** —
  kept. Attio itself skins one API flag three ways (Multi-select type,
  "Multiple values" checkbox, relationship cardinality); there is no clean
  precedent to copy.
- **rating carries `options.max`** (default 5) — superset of Attio's fixed
  5 stars. Kept.
- **url is a real type** — Attio has none (socials are bare text). Kept.
- **domain/email/phone as attribute types are for non-identity fields only**
  (e.g. a "support email" custom attr). Identity domains/emails live in
  `entity_alias` under resolution rules — hard exclusion, unchanged.
- **number gains `options.precision?: 0–4`** (new, from the UI study —
  "Founded 1,987" is the bug without it). Display-side: precision + thousands
  grouping via `fmtMoney`-family helpers, never `Intl` compact.
- Not adopted: interaction (arrives with email/calendar ingestion as
  system-computed), personal-name/location composites (expansion path),
  formula + AI autofill (deferred, decided 2026-08 — see CONTEXT.md).

## 3. Lifecycle contract (new — the probe findings, hardened)

| Rule                  | Us                                                                                                                                                                            | Attio observed                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Type after creation   | **immutable** — no update path exists, validator rejects                                                                                                                      | immutable (PATCH rejects `type`)                                                                                 |
| Slug                  | derived from name at creation, **immutable forever**, never shown in UI                                                                                                       | hidden in UI but mutable via API (footgun — we close it)                                                         |
| Name                  | freely renameable, slug untouched                                                                                                                                             | same                                                                                                             |
| Delete                | **no delete path**, archive only (system and custom alike)                                                                                                                    | same (no DELETE endpoint)                                                                                        |
| Archive semantics     | attribute hidden from all UI surfaces; writes rejected; **values stay in jsonb untouched**; unarchive restores them intact                                                    | same (read-time filtering, verified)                                                                             |
| Select/status options | archive-only once any value references them; archived option: hidden from pickers, writes rejected, existing values render with an "archived" treatment rather than vanishing | Attio _hides_ existing values entirely — we deviate: silently vanishing data in a record rail reads as data loss |
| System attributes     | `is_system`: archivable, never deletable; options editable (structure fixed, content free)                                                                                    | same                                                                                                             |

The one place we deviate (archived-option display) is deliberate: Attio
returns an empty array for a value whose option was archived; a self-hosted
tool whose user IS the admin should show the stale chip greyed with an
"archived option" tooltip instead.

**Archived options across surfaces (grilled 2026-09):** write pickers never
show them; existing values render greyed; **filter dropdowns DO show them,
under an "Archived" divider** — filtering is reading history (archived
values are part of it), writing is asserting now (they're excluded). This
is the bridge that makes cleanup possible: find the 40 records still on the
retired option, retag, done — hide them from filters and those records
become unfindable debt. Kanban: an archived stage with remaining deals
renders as a greyed column until emptied. Archived _attributes_ by contrast
disappear from filters wholesale — querying one is answered by unarchiving.

**Config mutability after values exist (grilled 2026-09):**

| Config field                  | Mutable?                             | Note                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currency.code`               | ✅ with warning                      | Pure relabel — no conversion machinery exists anywhere (fx_rate is a manual portfolio event table, nothing polls rates), so the legitimate case is "label was wrong all along." Edit dialog warns it changes how all existing values display. |
| `rating.max`                  | raise ✅ / lower ⛔ if values exceed | Error names the offending count.                                                                                                                                                                                                              |
| `number.precision`            | ✅ freely                            | Display-only; stored numbers untouched.                                                                                                                                                                                                       |
| `status` option `group`       | ✅ freely                            | Groups are interpretation; values store option ids.                                                                                                                                                                                           |
| `record_reference.targetKind` | ⛔ ever                              | Invalidates every stored UUID + link row — equivalent to a type change.                                                                                                                                                                       |
| `record_reference.multi`      | ⛔ v1                                | Single→multi widening is plausible but needs a value-shape migration; build it when someone actually hits it, not before.                                                                                                                     |

## 4. Defaults (new — adopt, simplified)

`options.default` per attribute, two forms, exactly Attio's model minus the
API/UI split they have:

- **static** — a value in the type's write shape (option id for selects,
  number, string, boolean…). Validated by the type's zod validator at
  attribute save.
- **dynamic** — two families only: `"current-user"` (actor_reference) and an
  ISO-8601 duration (date: `"P7D"` = a week out; `"PT0S"` = today).
  No other dynamic templates; no expression language smuggled in here.

**Firing rule (grilled 2026-09): defaults fire on every creation path** —
dialog, composer, import, and future machine creation alike. A default is a
standing human instruction, deterministically applied — the email-filter
analogy, not machine opinion; the suggestion doctrine gates _generated_
judgment, and a default is authored and inspectable. Three footnotes:

- **Fill-blanks only** — a default never overwrites a supplied value
  (imports: unmapped columns default, mapped columns win).
- **`current-user` resolves only when a human is present**; machine
  creation skips it silently (the record lands ownerless, which is true).
  Near-theoretical anyway: machines create people/companies (substrate for
  interactions), never deals — deal birth is judgment and stays human, so
  the attributes carrying `current-user` defaults are human-born.
- **Guidance, not validation** (per the extensibility doctrine): prefer
  defaults that mean "untriaged" (`Unrated`) over defaults that mean
  "judged" (`Medium`). The engine allows the landmine; the docs name it.

Applied server-side in creation server-fns, written through `setValues` so
`attribute_event` logs them. First user: `deal.owner` defaults to
`current-user` — kills the most repetitive click in deal capture.

**Typed actor (grilled 2026-09, schema evolution for the integrations
phase).** `attribute_event.actorId` as a nullable user FK cannot honestly
attribute machine or system writes — null means "nobody," not "the sync."
Adopt Attio's typed-actor idea without its polymorphic-id shape (CONTEXT
rejected untyped `(type, id)` pairs):

```
actor_type: 'user' | 'integration' | 'system'   -- new, not null
actor_id → user.id                               -- existing FK, set iff type='user'
-- integration FK added when the integration table exists
```

Attribution answers "who _attended_ to this value," never just "who caused
the flow" — a sync-created record is logged `integration` (traceable to
whoever connected it via the integration's own config), not stamped with
that user as author of assertions they never saw. The merge executor's
rewrites get `system` — they currently have no honest actor at all.
Defaults fired from a sync log as `integration`; from the dialog, as the
creating `user`.

## 5. Constraints

- `options.required` — **means "can't clear," nothing more (grilled
  2026-09).** The engine rejects an explicit clear of a required attribute,
  all types (generalizing the existing record_reference-only check in
  `values.ts`). A record may be _born_ without the value — creation
  completeness is the create dialog's concern, and machine writes/imports
  legitimately create partial records (the fill-blanks doctrine depends on
  it). The full at-all-times invariant was rejected: toggling required on
  existing data makes it a lie, and there is no honest backfill. System
  requirements that must hold at birth (deal.company) stay hard-coded in
  creation server-fn signatures, independent of the flag. Creation UI shows
  the constraint for every type except checkbox (unchecked is a value, not
  an absence).
- **Unique — rejected.** Attio shows a Unique toggle nearly everywhere; we
  don't take it. Uniqueness of identity (domain/email/linkedin) is
  `entity_alias` + the dedupe pipeline's job; unique on arbitrary attributes
  is a constraint without a domain story. Revisit only with a concrete case.

## 6. References and the graph (exists — restated as contract)

No mirror attributes, no two-way relationship configurator. A
`record_reference` write syncs a `link(relation: 'references', attr_slug)`
row in the same transaction; the reverse direction is the link graph queried
at read time ("related" rails, backlinks), and the merge executor rewrites
both. Attio's Relationship type (two named attributes, 4 cardinalities kept
in sync) buys presentation we get from the graph for free — the cost
(schema-coupled attribute pairs, sync invariants) is their biggest source of
model complexity and our merge executor's worst enemy. Cardinality is the
owning side's `multi` flag; nothing else.

`deal.company` stays required+single; `deal.people` optional+multi.

## 7. Create/edit dialog (new — the UI spec)

One morphing dialog. Fixed header, per-type slot, footer. No slug field, no
AI section, no per-type sub-dialogs — except record_reference gets a target
picker inline (our "Relationship dialog" equivalent is just the slot; the
graph makes the second panel unnecessary).

```
Type ▾  →  Name  →  Description (optional)
────────────────────────────────────────
[type slot]
────────────────────────────────────────
Default (optional, per-type widget)
[ ] Required            (hidden for checkbox)
             [Cancel]  [Create ⌘↵]
```

Type slots:

| Type                                                                    | Slot contents                                                                                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text / date / checkbox / url / domain / email / phone / actor_reference | _(empty)_                                                                                                                                                      |
| number                                                                  | Precision `[0–4]` (default 0)                                                                                                                                  |
| currency                                                                | Currency code dropdown (default USD, required)                                                                                                                 |
| rating                                                                  | Max `[3–10]` (default 5)                                                                                                                                       |
| select / multi_select                                                   | Inline options editor: rows with color dot + label, drag to reorder, Enter appends (composer-bar pattern); archive-not-delete once values exist                |
| status                                                                  | Same editor + per-option **group** chip (active / parked / closed) — our funnel semantics, richer than Attio's positional grouping; no target-time/celebration |
| record_reference                                                        | Target object (company/person/deal, single-pick) + `[ ] Multiple values`                                                                                       |

Default-value widget matches the type (option picker, star row, date picker
with "relative" toggle, user picker with "current user" shortcut). Type is
pickable only at creation; the edit dialog shows it as static text.

Editing reachable from the record rail and a per-object settings page
(registry list view: name, type, constraints, archived toggle, drag order —
the study's Attio attributes-settings page, minus Permissions/Templates).

## 8. Deferred, with the reason on record

- **Formula** — interpreter + reactive invalidation + type inference; the
  2026-08 survey stands. Our `attribute_event` log makes Attio's
  differentiator (history functions) nearly free _when_ it lands.
- **AI autofill family** — lands with BYOK AI phase under the suggestion
  doctrine (never silent, manual trigger, research-graph context). The Attio
  UI study confirmed even they don't auto-compute.
- **Lists/entries** — deferred (CONTEXT). The membership-vs-instance
  question is **closed (2026-09-07): lists are views, records are unique.**
  Attio entries are _instances_ (same record twice in one list, independent
  stages, entry-owned values); we reject that — a list is a saved filter
  with columns and no values of its own, and anything worth saying about a
  record is an attribute on the record. See CONTEXT.md "Lists — deferred".
- **timestamp, structured location, attribute descriptions as prompt
  context** — expansion path order unchanged.
- **Temporal value store** — rejected above; recorded so it isn't
  re-litigated per feature.

## 9. Custom objects — the two-tier model (decided 2026-09-02)

Reverses the CONTEXT.md non-goal, narrowly. Users create objects; objects
are **attribute bags**, verified against Attio's own boundary (their customs
are born with record_id/created_at/created_by only; domain/email attribute
types rejected on them; no dedupe, no interactions).

**Core objects** (company, person, deal — fixed in code): full machinery.
Identity/aliases, dedupe, merge, enrichment, interactions, seeded
attributes, per-kind side tables.

**Custom objects** (user-created):

```
object(id, slug, singular, plural, icon?, archived, created_by, created_at)
```

- **One registry, system rows (grilled 2026-09):** the `object` table seeds
  three system rows (company/person/deal, `is_system` — the system-attribute
  pattern one level up) plus user-created rows. The attribute table rekeys to
  a single `object_id` FK — no dual keying, no enum branch in any registry
  read; registry-generated UI is one query regardless of object. `entity.kind`
  enum _stays_ as the machinery dispatch switch (merge/resolution/side tables
  branch on it); customs share `kind = 'custom'`, differentiated by
  `object_id`. `entity.object_id` is set for every record-of-an-object,
  null for research kinds (note/space/document — not objects). Invariant
  (code, not constraint): a core entity's kind agrees with its object row.
  Migration is mechanical (enum → FK, backfill object_id) and cheapest now.
- Full attribute engine — every section of this spec applies unchanged.
  References work both directions (custom → core, core → custom); reference
  targets remain single-kind (§6 grilling), the picker just lists more
  objects.
- **Free from the polymorphic core:** spaces tagging, mentions/backlinks,
  filed notes/documents, search, activity timeline. This is the position
  Attio's customs don't have — theirs are isolated bags, ours land inside
  the research graph.
- **Permanently excluded** (the narrowed non-goal): alias resolution,
  dedupe, merge-as-target, enrichment, interactions, identity attribute
  types (domain/email as identity — allowed only as plain non-identity
  fields). Merge of _core_ records that customs reference is already safe:
  reference rewriting is link-graph-driven, kind-agnostic.
- **UI is registry-generated or it doesn't ship:** one route pair
  (`/o/$objectSlug`, `/o/$objectSlug/$recordId`) rendering list + record
  pages from the registry. Custom objects are the proof of the
  registry-generates-UI doctrine.
- Promotion path unchanged: a custom object that proves universal ships as
  a system object in a release (gaining machinery deliberately, in code).

**Birth contract (grilled 2026-09):**

- Display name = `entity.canonical_name`, **required at creation** — core-
  owned, never an attribute. Beats Attio's nameless bags (their customs have
  no name attribute at all; UI leans on the first text attr): every custom
  record is mentionable/searchable/referenceable from birth. Consequence:
  imports into a custom object must map a name column or refuse.
- Born with **zero registry rows** — created_at/created_by/id are entity
  columns rendered from the entity, not attributes.
- Creation dialog: singular noun, plural noun (auto-suggested, editable),
  optional icon. Slug derived from plural, immutable, hidden (§3 rule).
  Lands on the object's attributes settings page.
- **No object cap** (Attio's 4/12 is a billing lever; guidance over
  enforcement).
- Object lifecycle = attribute lifecycle: nouns rename freely, slug frozen,
  archive-not-delete (hides routes/pickers, records persist, unarchive
  restores).

## 10. Build delta (what this spec changes in code)

1. `options.default` support: registry type, zod validation of the default
   itself, application in record-create server-fns, `deal.owner` seeded
   default `current-user`. (§4)
2. `options.precision` for number; render path. (§2)
3. Lifecycle enforcement: no type/slug in the attribute-update server-fn
   signature (make illegal states unrepresentable, not validated away);
   archive/unarchive fns; option archive with greyed-chip rendering. (§3)
4. The morphing create/edit dialog + per-object attributes settings page. (§7)
5. Required-at-write enforcement: generalize the record_reference-only
   can't-clear check in `values.ts` to all types. (§5)
6. Config-mutability guards in the attribute-update fn per the §3 table
   (currency warning, rating-max lowering check).
7. Custom objects (§9): `object` registry table, `entity.object_id`,
   attribute rekeying migration, `/o/$objectSlug` route pair, object create
   dialog. The largest item; sequence after 1–6 harden the engine it rides on.
8. Typed actor on `attribute_event` (§4) — enum + invariant now, integration
   FK when the integration table ships.

**Build sequence (grilled 2026-09, closes the grilling):**
① object-registry migration first — schema surgery cheapest before anything
builds on the old keying (seed 3 system object rows, rekey attributes
enum→FK, backfill `entity.object_id`) → ② engine hardening on the new
keying: required can't-clear for all types, config-mutability guards, typed
actor → ③ defaults (+ `deal.owner = current-user`) → ④ morphing attribute
dialog + per-object attributes settings page → ⑤ object creation dialog +
`/o/$objectSlug` routes. Rationale: custom objects multiply every engine
behavior N-fold — the rules must be true before they get ten tenants, and
the registry-generated surface must exist before objects depend on it.

Non-goals restated: unique constraint, formula, list engine, per-attribute
permissions, and all core machinery on custom objects (identity, dedupe,
merge, enrichment, interactions).
