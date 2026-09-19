# Chapter 2 — the entity graph: identity, resolution, merge

`src/lib/entities/` is the identity layer. Three files, each "the one place"
for its concern: `normalize.ts` (key normalization), `resolve.ts` (entity
creation and matching), `merge.ts` (the merge executor). The tests are
integration tests against the dev database and double as behavior
documentation; read them alongside the code.

## `normalize.ts` — the normalization rules

The header comment states the invariant: these functions are the only place
normalization happens. Every alias write and every lookup goes through them,
or matching silently rots.

Three embedded rule sets:

- `FREE_MAIL`: 24 free-mail domains (gmail, yahoo, proton, icloud, …).
  Doctrine: a free-mail domain never creates or matches a company.
- `ROLE_PREFIXES`: 26 local parts that never identify a person (info, hello,
  pitch, founders, noreply, …). Anyone can send from them; matching on one
  would weld strangers together.
- `LEGAL_SUFFIXES`: a regex stripping one trailing legal form (Inc, Pvt Ltd,
  GmbH, Labs, Technologies, …) before fuzzy matching. Note it strips only
  one suffix: "Foo Labs Inc" becomes "foo labs", not "foo".

The functions:

- `normalizeDomain` runs `tldts.getDomain` to get the registrable domain
  (eTLD+1), so `https://app.deel.com/login` → `deel.com` and
  `Docs.Google.CO.IN` → `google.co.in` (real multi-part eTLD handling).
  Returns null for garbage and for free-mail domains, so every caller
  inherits the free-mail rule automatically. `mail.yahoo.com` reduces to
  yahoo.com and dies here.
- `normalizeEmail` lowercases and splits on the last `@`. Gmail only:
  strips `+tags` and dots from the local part and canonicalizes
  googlemail.com to gmail.com (`an.ish+deals@gmail.com` → `anish@gmail.com`).
  Other providers keep dots significant.
- `normalizeName` produces the fuzzy-match form, never identity: lowercase,
  NFKD, strip diacritics, strip a legal suffix, collapse punctuation to
  spaces. `Café Coffée Day` → `cafe coffee day`. This feeds pg_trgm only.
- `normalizeLinkedin` canonicalizes `linkedin.com/(in|company|school)/slug`;
  everything else → null.
- `normalizeCin` validates the Indian Corporate Identification Number
  structurally (21-char regex, no checksum).

The only importer is `resolve.ts`. That's the point.

## `resolve.ts` — the choke point

`resolveEntity()` is where every entity creator must go: manual create,
future deck extraction, mentions, Gmail, Apollo. The doctrine is one line:
**deterministic auto, probabilistic suggest**. Exact identity-key matches
attach automatically; fuzzy name similarity only ever files a suggestion in
the dedupe inbox. The system never merges on a guess.

The algorithm, step by step:

1. **Normalize keys** (`normalizeKeys`). Each provided key runs through its
   normalizer; keys that normalize to null are silently dropped, so a
   gmail.com "company domain" simply vanishes from the key list. A role
   email on a person is dropped here too. No name and no surviving keys →
   throw.
2. **Deterministic pass.** For each key in fixed priority order (domain,
   email, linkedin, cin), look up `entity_alias` for
   `(kind, value_norm, is_identity = true)`. First hit wins: follow
   `canonicalId()` (one hop through `merged_into_id`; merge flattens
   chains, so one hop is guaranteed), record the incoming name as a
   non-identity name alias (a new name for a known entity is still signal),
   return `{action: 'attached', matchedOn}`. Name aliases can never cause an
   attach; the lookup filters on `isIdentity`.
3. **Create.** One transaction: insert the entity, one identity alias per
   surviving key (raw value and normalized value both stored), the name as
   a non-identity alias, and the kind side-table row (company/person;
   organizations have none).
4. **Probabilistic sweep**, outside the transaction and best-effort (a
   failed sweep never fails a create). A pg_trgm query finds other entities
   of the **same kind** whose name aliases satisfy
   `value_norm % name_norm AND similarity >= 0.5`, and files each as a
   `duplicate_candidate` via `suggestDuplicate`.

`suggestDuplicate` orders the pair (a < b on uuid) and inserts with
`onConflictDoNothing`. That conflict clause is what makes "dismissed stays
dismissed forever" true: a dismissed row occupies the unique pair and blocks
re-suggestion.

`addIdentityAlias(entityId, kind, rawValue, source)` is the enrichment path
(adding a domain or email to an existing record). It follows the canonical
id first (callers may hold a stale merged-away id), throws on invalid input
(unlike resolveEntity, which drops silently), and then checks who currently
owns the key:

- nobody → insert the identity alias, return `added`
- this entity (after redirects) → `already_own`
- someone else → file a duplicate candidate with score 1.0 and reason
  `{shared: kind}`, return `suggested_duplicate`

The comment calls the unique index "the dedupe tripwire": a collision means
another entity already owns this key, and that's a duplicate candidate, not
an error. Enrichment finds your duplicates as a side effect. The UI surfaces
all three outcomes (chapter 6, `addCompanyDomain` / `addPersonContact`).

Things the tests pin down: `www.` prefixes normalize away and attach with
`matchedOn: 'domain'`; two companies "created" with gmail.com domains are
two distinct entities; a name plus `Pvt Ltd` never attaches but does produce
a candidate with score ≥ 0.5 (the legal-suffix strip makes the trigram
similarity high); role emails on people never match.

Callers: `createCompany`, `createPerson`, and the demo seed (which goes
through the choke point deliberately: "demo data must go through the same
identity rules as everything else, or it is not a demo of this product").

## `merge.ts` — the merge executor

The most dangerous file in the repo, per CLAUDE.md: a table that references
entities and never reaches the repoint sections leaves rows pointing at a
merged-away id, and its snapshot gap makes unmerge impossible for that
table. Missing one was the worst bug of a review cycle — which is why the
hand-written list is gone. `ENTITY_REFS` (`packages/db/src/entity-refs.ts`) is now
the one list of entity-referencing columns, this file loops over it for
every generic repoint, and `entity-refs.test.ts` diffs the list against
drizzle's FK metadata so a new column can't skip it.

Doctrine from the header: repoint at write time, resolve nothing at read
time. The loser survives as a redirect (`merged_into_id`); every moved or
dropped row lands in `merge_event.snapshot`. Merging is restricted to
company/person/organization and same-kind pairs; spaces and notes have
structural children and different semantics.

One export: `mergeEntities({winnerId, loserId, mergedBy, candidateId?})`.
The whole thing is a single transaction: merge is all-or-nothing. The
snapshot is a flat ordered array of
`{table, action: repointed|dropped|field_filled|field_conflict, pk, old}`.
There is no unmerge executor; the snapshot is the raw material for one.

Each `ENTITY_REFS` entry declares one of four merge strategies:
`repoint` (plain `update set col = winner where col = loser`),
`repoint-or-drop` (same, but the row would collide with a unique index the
winner already satisfies — same space, same interaction, same task, same
round — so the loser's row is snapshotted and dropped), `custom` (a
hand-written section here, named by handler so the two stay findable), or
`none` with the invariant that makes skipping safe. The five custom
handlers are checked **at import**: a registry entry naming a handler
nobody wrote throws the first time this module loads.

The sections, in execution order (worth reading with the file open, because
the ordering itself is load-bearing):

1. **Guards**: no self-merge, both sides exist, neither already merged,
   same kind, kind is mergeable.
2. **Aliases** (custom): loser aliases the winner already has are
   snapshotted and dropped; the rest repoint with `source: 'merge'`.
3. **Links** (custom): every link touching the loser is deleted and
   re-inserted with substituted endpoints (`onConflictDoNothing` absorbs
   duplicates; self-links are not re-inserted). Before this runs, the code
   captures `inboundRefs`, the loser's inbound `references` links. Step 5
   needs them, and they must be read **before** the link table is
   rewritten. If you reorder these sections, step 5 breaks silently.
4. **Every generic edge column: one loop over `ENTITY_REFS`** — space tags,
   interaction attendees, task links, signals, enrichment records, activity
   in both roles, `attribute_event` history, rounds, round co-investors and
   the investments booked against a deal.
   Composite-PK join tables are addressed by their column values, so the
   id-less ones work too, and each repoint or drop lands in the snapshot
   under the entry's `key` (`<table>.<role>`).
5. **Attribute values**: winner's `entity.values` wins field by field.
   Loser value fills a winner null (`field_filled`); a genuine conflict is
   recorded (`field_conflict`) and the loser's value is discarded, no user
   prompt. The snapshot keeps both sides. Value rewrites emit an
   `attribute_event` with actor `system`, door `merge`, so the timeline
   never shows them as a teammate's edit.
6. **Referrers' record-reference values**: for each captured inbound
   `references` link, rewrite the referring entity's `values[attrSlug]`,
   scalar or array, with a Set dedupe (a deal referencing both loser and
   winner in a multi-reference collapses to one).
7. **Portfolio holdings** (custom): one holding per company. If both sides
   have one, every investment/mark/distribution repoints onto the winner's
   holding and the loser's holding row is deleted (snapshotted); otherwise
   the holding's companyId repoints.
8. **Other open duplicate candidates** (custom) touching the loser:
   dropped, and re-filed against the winner (suggestions transfer to the
   survivor). The triggering candidate flips to `merged`.
9. **Redirect + chain flatten** (custom): set the loser's `mergedIntoId`,
   and repoint every entity whose `mergedIntoId` pointed at the loser. This
   is what keeps `canonicalId()` a single hop.
10. Insert the `merge_event` and an `activity` row (`entity.merged`).

One caller: `mergeDuplicate` in `server/dedupe.ts`.

The big merge test is worth reading end to end: it builds winner and loser
with domains, a space tag, an inbound mention, and a value, merges, then
asserts the redirect, alias ownership, moved links and tags, the value
fill, the snapshot contents, and, crucially, that re-resolving the loser's
domain now attaches to the **winner** (the redirect and alias move working
end to end), and that `addIdentityAlias` on the stale loser id answers
`already_own`.

## `test-helpers.ts`

`cleanupTestEntities(patterns)` deletes test entities and their dependents
in FK-safe order. Trap: its deletion list is the one shadow of the table
list that `ENTITY_REFS` doesn't cover — a new entity-referencing table
needs a line here too, or cleanup starts failing on FK violations. It
currently skips portfolio and task tables because no test creates them.

## What to hold onto

- Identity lives in `entity_alias`, never on side tables, and is unique per
  `(kind, valueNorm)` where `isIdentity`.
- `entity.values` jsonb is authoritative; `link(references)` rows are a
  derived index of it. Chapter 3's `setValues` rebuilds them; merge
  rewrites both.
- A column that gains an entity FK goes in `ENTITY_REFS` first (merge
  strategy + context role) — the diff test names it otherwise. Beyond that
  registry, only `test-helpers.ts` cleanup still needs a hand-written line.
- The dedupe inbox is fed from two directions: fuzzy name sweeps at create
  time, and identity-key collisions during enrichment. Humans resolve both;
  code never merges on its own.
