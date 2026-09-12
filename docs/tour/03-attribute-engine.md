# Chapter 3 — the attribute engine, glossary matcher, and seeds

`src/lib/attributes/` is the object model's core: a fixed type menu, a
user-owned registry, one validated write path. This chapter also covers the
glossary's Aho-Corasick matcher and the three seed modules, because they
share the same "structure fixed, content free" doctrine.

## `registry.ts` — types, validators, system attributes

The type menu is fixed in code; users define attributes, never types.
Fifteen types: text, number, currency, date, checkbox, select,
multi_select, status, domain, email, url, phone, rating, record_reference,
actor_reference. `ObjectKind` is company | person | deal only, narrower
than entity kinds: notes, spaces, and terms are deliberately not
object-modeled. `CORE_OBJECTS` maps each kind to its seeded object-registry
row (slug/singular/plural); registry reads key on `object_id`, and
`objects.ts` does the kind → id resolution with a process-lifetime cache.
That module is also the repo's first Effect code: `Effect.fn` with tagged
errors, plus an `objectIdForKindAsync` promise seam for call sites the
ratchet hasn't converted yet.

`valueValidator(def)` returns a Zod schema for a single value. The
interesting cases:

- `date` is a string matching `^\d{4}-\d{2}-\d{2}$`, consistent with the
  repo-wide dates-as-lexically-comparable-strings rule.
- `currency` is a plain finite number; the currency code is metadata in
  `options.code`, not part of the value.
- `select`/`status` validate against `z.enum(optionIds)`, and degrade to
  `z.never()` when an attribute has no options (nothing validates rather
  than everything).
- `record_reference` is a uuid or a uuid array depending on
  `options.multi`; `actor_reference` is a user id string, not validated
  against users here.

`SYSTEM_ATTRIBUTES` is the complete seeded set. Companies: description,
business_model (multi-select), funding_stage (select with colors),
location, founded_year, linkedin. People: job_title, description,
location, linkedin, twitter, phone. Deals carry the load-bearing ones:

- `stage`, the one **status** attribute, whose options carry
  `group: active | parked | closed` (pre_lead through term_sheet are
  active; "Early — revisit" is parked; invested, passed, lost are closed).
  Chapter 6 showed four surfaces depending on that group field.
- `company` (record_reference, required, single), `people` (multi),
  `owner` (actor_reference), `value` (currency USD), `close_date`,
  `source`, and `close_reason` (text, captured at close time while the
  post-mortem is fresh).

Seeding is insert-if-absent and never overwrites: options are user-editable
content after first boot.

One known seam: the demo seed writes `funding_stage: 'series_b'` for one
company via a raw values update, and the registry's option id is
`series_b_plus`. Raw updates bypass validation; the invalid id sits there
harmlessly but is a nice illustration of why `setValues` exists.

## `values.ts` — the one write path

`setValues({entityId, patch, actorId})` has patch semantics: keys present
are set, null clears, absent keys are untouched. The write path:

1. One transaction, opening with `SELECT … FOR UPDATE` on the entity row.
   This lock is load-bearing: the write is a read-modify-write of the whole
   `values` blob, and at READ COMMITTED two concurrent editors of
   _different_ attributes would both read the same starting blob and the
   second commit would silently erase the first's key. The row lock
   serializes the merges.
2. Load the registry for the entity's kind; unknown slug → validation
   error.
3. Per key: coerce `undefined | null | ''` to null (empty string clears);
   validate non-null values with `valueValidator`; block clearing a
   required record_reference; diff against the current value via
   JSON.stringify and skip no-ops entirely (no event written).
4. Record references get target checks: every referenced id must exist,
   match `options.targetKind`, and **not be merged away**. References must
   point at canonical entities; this path does not follow redirects.
5. Apply the change (cleared keys are deleted from the blob, not stored as
   null), and insert one `attribute_event` row per changed slug with
   from/to jsonb. This is where all field history comes from.
6. For record references, **materialize the graph**: delete all links
   `(from = entity, relation = 'references', attrSlug = slug)` and insert
   one per target. The jsonb is authoritative; the link rows are a derived
   index rebuilt wholesale on every change. These are exactly the links the
   merge executor's step 10 rewrites.

Callers: `createDeal` (initial values, including the default
`stage: 'pre_lead'` and the owner) and the generic `updateRecord`. Both
carry the invested→birthHolding hook described in chapter 4.

Tests pin the essentials: three-key patch writes exactly three events; the
company reference materializes exactly one link; clearing required company
throws; referencing a deal from a company slot throws; re-patching an
identical value writes zero events.

## `seed.ts` and `colors.ts`

`seedSystemAttributes()` runs on every boot from `db/migrate.ts`: first the
three system object rows (insert-if-absent by slug), then attributes —
select by (objectId, slug), skip if present, insert with
`sortOrder: (i+1)*10` (gaps of 10 leave room for user attributes between).
New system objects and attributes in a release appear on upgrade without
stomping edits.

`colors.ts` names the twelve badge colors; `styles.css` owns the values as
CSS variables. CSS variables rather than Tailwind classes because the color
comes from data, and Tailwind's static extraction would never emit
`bg-badge-${name}`. Two functions with distinct roles:

- `optionColor(option, index)`: render-time. Explicit color wins, else
  positional palette by index. Positional, not group-seeded, so an old
  option set with no stored colors still renders fully colored, and a
  funnel's columns don't all paint the same blue.
- `nextBadgeColor(index, group?)`: creation-time only. New status options
  seed by group (active → blue, parked → amber, closed → slate); never used
  as a render fallback.

## `glossary/aho-corasick.ts` — the term matcher

A dependency-free Aho-Corasick automaton (~120 lines; the alternative was a
library that does the same thing plus a bundle and a supply-chain surface).
One pass over a note body finds every glossary term and alias at once.

The matching semantics are chosen to be predictable rather than clever:

- case-insensitive
- whole-word only: "stage" never matches inside "backstage", and there is
  no stemming, so "stages" is a documented miss. A glossary that lights up
  unpredictably is worse than one that occasionally misses a plural.
- longest match wins, leftmost first, never overlapping: with both "space"
  and "in-space manufacturing" defined, the phrase wins.
- hyphens are word boundaries, so "space" does match inside "in-space" when
  the longer phrase isn't defined.

`buildAutomaton(patterns)` builds the trie by code point with BFS failure
links, inheriting outputs along failure links (the classic "her" inside
"usher" case). `findMatches` scans by code unit so offsets map straight
back onto the original string, enforces word boundaries per raw hit, then
resolves overlaps by sorting (start asc, end desc) and greedy sweeping.
Matches carry the haystack's casing, not the term's.

The one caller is `components/editor/glossary-decoration.ts` (chapter 7),
which runs it per text node of the ProseMirror document.

## The three seeds, three lifetimes

The seeds are worth reading as a set because each has a deliberately
different posture:

- **System attributes** (`attributes/seed.ts`): every boot,
  insert-if-absent. Code-owned structure, user-owned options.
- **Starter taxonomy** (`seeds/taxonomy.ts`): first boot only; if any space
  exists, return. Re-running would resurrect nodes the operator deleted;
  the taxonomy is theirs from the moment they touch it. The starter set is
  deliberately tiny (data_centers/cooling, aerospace/in_space_manufacturing,
  fintech): a shipped ontology would pre-empt the investor's own
  vocabulary. Idempotency is on the materialized ltree **path**, not the
  slug, because the path is the only stable identity a node has.
- **Demo data** (`seeds/demo.ts`): opt-in at setup, guarded by "zero
  companies exist". Three spaces, three immersion-cooling companies, one
  person, three glossary terms, one memo whose body deliberately uses the
  glossary vocabulary so term highlighting lights up on first open.
  Companies and the person go through `resolveEntity`, not raw inserts.
  Values are written raw (no validation, no events), which is where the
  invalid `series_b` id comes from. One trap documented in the code: a
  third-level space needs its parent's **full** path accumulated, or
  `immersion` silently lands at the root as `cooling.immersion`.

## What to hold onto

- One write path (`setValues`), one validator per type, one registry that
  generates columns, forms, and rails. If you're writing `entity.values`
  any other way, you're bypassing validation and history; the demo seed is
  the only sanctioned example.
- The `FOR UPDATE` row lock in setValues is not decoration; removing it
  reintroduces a lost-update bug between concurrent editors.
- Status option `group` and option ids are contract surfaces. Options can
  be renamed, never removed, because records hold their ids.
