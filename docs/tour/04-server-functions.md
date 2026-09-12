# Chapter 4 — server functions: the only write path

`src/lib/server/` holds one file per domain, 18 files, ~4400 lines. Every
mutation in the product goes through a function here. This chapter covers
the barrel trap, the auth model, the shared helpers, then each domain file,
and closes with the cross-cutting patterns.

## The barrel: `src/lib/server-fns.ts`

A pure re-export barrel that client code imports. It re-exports 17 of the
18 server files; `shared.ts` is the one it does not, and that's the trap:
because the barrel is client-imported, it may only carry `createServerFn`
wrappers and types. A plain server helper exported through it would be
bundled into the browser. That is why `birthHolding`, `requireUser`,
`canRead`, and friends live in `shared.ts`.

## Conventions that repeat everywhere

Stated once so the per-file notes stay short: every function starts with
`await requireUser()` (or `requireAdmin`); inputs are validated with zod
`.validator(...)`; mutations are POST; Date columns are serialized with
`.toISOString()` before returning; and every list or backlink query filters
`isNull(entity.mergedIntoId)` so merged-away entities never surface.

## `shared.ts` — the helpers

- `requireUser()`: session from Better Auth via request headers; throws
  `Unauthorized` without one.
- `requireAdmin()`: admin owns settings, keys, members, and structural
  edits; everything else any member writes. A two-person fund has no
  ceremony.
- `canRead(user, row)`: deliberately trivial; false only for a private note
  that isn't yours. The point of the choke point is that it exists.
- `toLabel(name)`: the ltree-safe slug derivation (lowercase, NFKD,
  underscores, 48 chars) shared by spaces, attribute slugs, and option ids.
- `createSpaceRow(name, parentId, userId)`: transaction creating a space
  entity plus its `space` row, with sibling-scoped slug dedupe (`_2`, `_3`)
  and path accumulation from the parent. Used by `createSpace` and the
  space-template stamper.
- **`birthHolding({companyId, actorId, openedAt?})`** is the
  pipeline→portfolio seam. Idempotent via
  `insert … onConflictDoNothing().returning()` against the unique
  companyId: one holding per company, follow-ons land on the existing row.
  On genuine creation it writes an `activity` row (`holding.created`).
  Three call paths: `updateRecord` when a patch sets `stage: 'invested'` on
  a deal; `createDeal` when a deal is born already at Invested; and
  `portfolio.ts` (`createHolding` directly, and `addInvestment`, which
  births first so an investment can never be orphaned).
- `lastTouchedMap()`: max interaction time per entity, the "last touched"
  column on company and people tables.

## The auth model

**`src/lib/auth.ts`** configures Better Auth. The session secret is derived
from the vault master key via HKDF (one secret for the operator to manage);
`baseURL` trusts `APP_URL`, not the request, which is what makes reverse
proxies with TLS termination work. Email+password, minimum 12 chars,
sessions as DB rows (revocation is a delete), roles admin/member via the
admin plugin.

The entire signup policy lives in a **database hook**, not routes, because
the public signup endpoint would happily bypass any route-level check:

- First run (`count(user) == 0`): require the `x-setup-token` header,
  verify, and **consume the token in the before-hook**. Two concurrent
  first-run signups both pass the count check, but only the first finds the
  token file. The new user is admin.
- Ever after: signup is closed; require `x-invite-token`. Redemption is an
  atomic conditional UPDATE (`SET usedAt WHERE tokenHash AND usedAt IS NULL
AND expiresAt > now() RETURNING role`), so two concurrent redemptions
  race the row and exactly one wins. If the invite was email-locked and the
  email mismatches, the invite is handed back (`usedAt = null`) so the
  rightful recipient can still use it, then the signup throws.

**`setup-token.ts`**: the token is a file (`<DATA_DIR>/setup-token`, mode
0600), printed to server logs; the operator is the one person who can read
them. It survives web restarts mid-setup, never enters the DB, and is
verified with `timingSafeEqual`.

**API routes**: `/api/auth/$` hands everything to Better Auth.
`/api/health` runs `select 1` and returns 503 when the DB is unreachable
(the Docker healthcheck target). `/api/blob/$key` is the local storage
driver's "presigned URL" endpoint: HMAC token + expiry checked, GET streams
the blob with hardened headers (always `application/octet-stream` +
`attachment` + nosniff, because an uploaded .html served as text/html from
this origin would be stored XSS; immutable cache headers, since
content-addressed keys never change), PUT re-verifies the sha256 digest as
it streams.

## Domain files

### attributes.ts

`listRegistry` (per kind, optionally archived) is the first handler run
through the Effect seam: its body is an `Effect.fn` program executed via
`effectFn()` from `server/effect.ts`, with auth left outside the program in
promise-land. That adapter is the whole Effect↔TanStack boundary (CLAUDE.md
"Backend paradigm") — new server code composes Effect programs and crosses
here; Effect never reaches React. `createAttribute` is
member-writable (additive); the user-creatable type list excludes
record/actor references and status, which stay system-only.
`updateAttribute` is the one **admin** gate in the content layer: renames,
option edits, and archiving reshape shared vocabulary. Its invariants:
options can never be removed ("records may hold that value. Rename it
instead"); new options derive ids from labels with collision suffixes;
options without an explicit color get one stamped at save so later edits
never reshuffle colors; colors are locked to the shipped palette. `move`
swaps sortOrder with the adjacent sibling.

### companies.ts

`createCompany` goes through `resolveEntity` (may attach instead of
create; activity only on genuine creation). `listCompaniesTable` builds
table rows in four batched queries (entities + values, identity domains,
space tags, lastTouched) with zero N+1. `getCompany` returns the head,
aliases, spaces, contacts (people via `contact_at` links), backlinks, and
the last 50 activity rows.

`updateRecord` is the generic record write for all three kinds: optional
rename (+ activity), optional patch through `setValues` (which does the
validation and writes `attribute_event`), then the birthHolding hook when
the patch moved a deal to invested.

`addCompanyDomain` delegates to `addIdentityAlias`: the dedupe tripwire
surfaced in the UI. `tagIntoSpace`/`untagFromSpace` write `entity_space`
plus activity.

### deals.ts

`createDeal` inserts the entity then routes the initial values through
`setValues` (so the company reference materializes its link and events are
written), writes activity, and births a holding when created at invested.

`listDealsTable` returns rows plus a `refNames` map (resolved
record-reference names) and `userNames` (owner is a user id, not an
entity). `getDeal` adds `outsideMandate`: null unless an active mandate
with stages exists and the deal's company has a funding stage; then simply
"stage not in mandate stages". A hint, never a block.

`dealFunnelStats` is the derived-not-stored pattern at its clearest:
nothing is stored; everything comes from `attribute_event` where
`attrSlug = 'stage'`. Stage-entry time for each deal is the newest event
whose `to` equals the current stage; from that fall out `countByStage`,
`medianDaysInStage` per stage, and the per-deal `daysInStage` list that
feeds the Today page's idle-deals section.

### dedupe.ts

`listDuplicates` hydrates each open candidate pair with a comparison card
(domains, other names, mention count, spaces); N+1 by design for a small
queue. `mergeDuplicate` guards (candidate open, winner is one of the pair)
and delegates to `mergeEntities`. `dismissDuplicate` marks the pair
dismissed, forever.

### documents.ts

Upload is two server calls around a direct-to-storage PUT: a 200MB deck
must not stream through Node.

- `prepareDocumentUpload({sha, sizeBytes})`: if the blob already exists,
  return `{uploadUrl: null, alreadyStored: true}` (content addressing means
  the same deck sent to both partners transfers once). Else a presigned URL
  plus the headers the client must send verbatim.
- `finalizeDocumentUpload`: blob must exist (throw 'Upload incomplete'),
  target entity must be live. Same sha already attached to the same record
  → return the existing row (`deduped: true`). Otherwise a transaction:
  document entity + document row + `tagged_in` link + activity, then the
  extraction job enqueued **outside** the transaction: a down queue must
  not roll back a good upload.
- `deleteDocument` is a real delete (chunks, links, activity, rows), and
  afterwards deletes the blob only if no other document row shares the sha.
  One file can back several rows.

`listRecordDocuments` carries a 200-char SQL `left()` snippet, never the
2MB extracted-text column; `getDocumentText` fetches the full text only
when a preview opens.

### glossary.ts

Terms are space-scoped; `spaceId = null` is global vocabulary. Inheritance
runs downward only, via ltree: `listTerms(spaceId)` returns the space's own
terms plus every ancestor's plus globals (`anc.path @> self.path`).
`listTermsForNote` resolves the note's filings to spaces and applies the
same ancestor logic; a note filed nowhere gets globals only. Filing a note
into Aerospace is what opts it into the aerospace vocabulary.

### interactions.ts

`logInteraction`: one transaction inserting the interaction, a deduplicated
attendee row per entity in the room (people, companies, deals), and one
activity row. Feeds `lastTouchedMap` and the record timeline. This is the
manual primitive that a future calendar sync will automate rows into.

### mandate.ts

Member-writable on purpose: the mandate is judgment, not settings.
`createMandate` builds prose-first (a real note entity plus the mandate row
pointing at it); `updateMandateFacts` sparse-updates stages, geos, and the
check range (validating min ≤ max). The stages array is what `getDeal`
reads for the outside-mandate hint.

### members.ts

Workspace read/rename (rename admin-only), member listing, role changes,
bans, and invites. Two invariants recur: the **last-admin guard** (you
cannot demote or ban the only active admin; banned admins don't count) and
session hygiene (banning deletes the user's sessions;
`revokeMemberSessions` is self-or-admin). `createInvite` generates the raw
token, stores only the hash, and returns the `/join?token=…` URL, the one
place the raw token ever exists. `getInvitePreview` is public (the /join
page runs pre-session) and returns only validity, email, role, and
workspace name.

### notes.ts

`createNote` seeds a starter paragraph with a mention of the record it was
opened from; if "about" is a space, it files via `entity_space` instead of
linking (standing in the space when you write is filing). `listNotes`
enforces visibility **in SQL** (`shared OR author`). `getNote` collapses
unreadable and missing into one error, 'Note not found', deliberately never
a 403: a 403 would confirm a private note exists. `setNoteVisibility` is
author-only; even admins can't flip someone's private note.

`saveNote` accepts title-only saves (body untouched) or a full body
`{bodyJson, bodyMd, mentionIds}`. The **mentions diff-sync**: mentionIds
are extracted client-side from the BlockNote doc; the sync's scope is only
link rows `(from = note, relation = 'mentions', source = 'extracted')`, the
rows it owns; compute wanted vs current sets, delete the stale, insert the
missing. Backlinks track the document body exactly, idempotently, without
touching manual links.

### objects.ts

The object registry's server half (spec §9 — the two-tier model). Reads:
`listObjects` (system rows first regardless of creation order, each with a
live-attribute count — archived attributes sit in the settings page's own
collapsed section and shouldn't inflate it) and `getObject` by slug.
Writes: `createObject` and `updateObject` are **admin**, on the same
reasoning as `updateAttribute` — reshaping the workspace's vocabulary.
`listObjectRecords` / `getObjectRecord` / `createObjectRecord` are the
generic record surface the `/o/$objectSlug` routes use, so a custom object
needs no code of its own. Effect-first throughout: tagged errors
(`ObjectNotFound`, `ObjectQueryFailed`), programs in `Effect.fn`, crossing
back through `effectFn()`.

### people.ts

Mirror of companies: `resolveEntity` on create (email as optional
identity), batched list queries, `addPersonContact` (email or linkedin,
same tripwire semantics), `setPersonCompany` (link/unlink `contact_at`).

### portfolio.ts (630 lines)

The server half of the financial engine. Reads are: load raw event rows,
`Number()`-parse every `numeric` string **at this boundary**, hand plain
numbers to the pure libs (chapter 5), serialize back.

- `listHoldings`: per holding, `holdingMetrics` (native currency display
  where possible) plus `ownership` from investments and rounds. The
  roll-up recomputes everything in base currency (`reportIn: 'base'`);
  holdings whose conversion fails land in `excludedForMissingRates`,
  reported and excluded, never silently converted at 1.0. That list is
  what the Today page renders as FX gaps.
- `getHolding`: the tear sheet; head plus all four event lists parsed.
- Writes: `addRound` (plus co-investor rows), `addInvestment` (births the
  holding first, dated at the investment), `addMark`, `addDistribution`
  (activity verb `holding.writtenoff` for write-offs). The four event
  tables have **no edit or delete functions**; append-only is enforced by
  simple absence. The one exception is `setFxRate`, an upsert, because
  correcting a rate is safe when nothing stored derives from it.
- `setBaseCurrency` is admin and just writes `workspace.settings`;
  changing it re-denominates every roll-up at the next read because
  nothing stored converts.

### search.ts

Two functions. `searchEntities` is the autocomplete: distinct-on entities
matched by ILIKE on canonical name or name-alias norm, kind-filtered,
limit 8, with a raw `NOT EXISTS` clause keeping private note titles out of
other users' results.

`searchAll` is the Cmd-K query, one SQL statement with four CTEs:

- `name_hits`: entities and their name aliases matched by ILIKE **or**
  `word_similarity` (`<%`). Word similarity, not whole-string similarity,
  because a short query against a long name always scores under the
  threshold; the word operator is what lets "orbitl" reach "Orbital
  Composites". Aliases count as names, so "Made In Space" finds a company
  stored under another label.
- `note_hits`: `note.tsv @@ websearch_to_tsquery`, visibility filter in
  SQL, snippet via `ts_headline` configured with `«»` markers.
- `doc_hits`: the same over extracted deck text.
- `fused`: UNION ALL, then group by entity with **reciprocal rank fusion**,
  `score = sum(1.0 / (60 + rank))`. Trigram scores and ts_rank aren't
  comparable, but ranks are; and everything searchable is an entity, so all
  sources rank the same id space. pgvector will join as a fourth CTE with
  nothing else changing.

Post-processing resolves each document hit's `tagged_in` parent, because
documents have no page of their own; a result must send you to the record
or it's a dead end.

### settings.ts

`getSession` and `getSetupState` are unauthenticated (route guards consume
them); getSetupState re-prints the setup token to the server logs on every
ask while setup is needed. `getOnboardingProgress` derives five booleans
from artifact counts (spaces, notes, mandate, companies, invites), so the
getting-started card can never disagree with the data. `saveAiKey`
(admin) stores an LLM key in the vault and returns only the masked
display. `seedDemo`/`canSeedDemoData` guard the demo seed.

### spaces.ts

`listSpaces` (ordered by ltree path, depth derived from it), `getSpace`
(ancestors via `path @> path` for the breadcrumb, children, tagged
companies, filed notes with the visibility filter in SQL, and referenced
notes minus already-filed ones so a note shows once), `createSpace` via
the shared helper.

### tasks.ts

Any member sees and completes any task; "mine" is a client scope, not a
permission. Create (with linked entities in one transaction), list (open
ordered by due date, done behind a flag), per-entity list, toggle done,
hard delete.

### templates.ts

Standardized capture, never automation; creation is by-example only.

- `saveNoteAsTemplate` recursively **strips mentions to plain text**: a
  template holding real entity references would spray ghost backlinks on
  every instantiation.
- `saveRecordAsTemplate` keeps only templatable values (record and actor
  references excluded, archived attributes excluded). There is no apply
  function for record templates: the create modal pre-fills visibly and
  the user submits. Nothing writes silently.
- `saveSpaceAsTemplate` captures names and glossary skeletons only, never
  memo content: a scaffold that copied memos would smuggle one market's
  research into another. `applySpaceTemplate` stamps the manifest
  skip-existing (reuse a same-named child rather than duplicate), the same
  insert-if-absent philosophy as the attribute seeder.

### timeline.ts

`getRecordTimeline` merges three sources: activity macros (minus verbs
superseded by richer items), interactions with co-attendees, and
**attribute bursts**: the last 200 attribute events walked newest to
oldest, grouped into one burst while the actor matches and the gap is
under ten minutes. A form save touching six fields renders as one entry.
Nothing is stored; condensing happens on every read. `getWorkspaceActivity`
is the Today page's feed: the last 15 activity rows with actor and subject
resolved.

### views.ts

Saved views (SPA-14), thin handlers over programs in `lib/views/store.ts`.
`listViews` takes a kind **or** an objectId (custom objects have no kind)
and returns shared views plus the caller's private ones. `saveView`
inserts or updates; `deleteView` removes. The permission rule lives in the
program, not the handler: anyone may create a view, private or shared, and
only its author or an admin may change or delete one. Views reference the
object row, never an entity — which is how they stay out of the merge
executor entirely.

## The auth-gate census

Worth memorizing the exceptions rather than the rule:

- **No auth**: `getSession`, `getSetupState`, `getInvitePreview`,
  /api/health, /api/blob (HMAC token instead).
- **Admin**: `updateAttribute`, `saveWorkspace`, `setMemberRole`,
  `setMemberBanned`, invite create/list/revoke, `setBaseCurrency`,
  `saveAiKey`.
- **Extra checks**: `revokeMemberSessions` (self or admin),
  `setNoteVisibility` (author only), note reads/writes (canRead).
- Everything else is plain member write, deliberately flat.

## Cross-cutting patterns

- **Visibility is enforced in SQL wherever a note could leak**: note lists,
  space pages, both search paths. The predicate version (`canRead`) covers
  single-row fetches. One known gap the notes flag: the `mentionedIn`
  backlink queries on company/person/deal pages do not filter private
  notes, so a private note's title can appear in another user's
  "mentioned in" list.
- **Transactions** wrap multi-row identity creation and hard deletes, not
  sequences of independent updates. Queue enqueues always sit outside
  transactions. Blob deletion happens after a post-transaction refcount.
- **Derived, not stored**, recurs everywhere: funnel stats from events,
  onboarding from artifact counts, metrics at read, timeline bursts at
  read, outside-mandate at read.
- **Idempotency habits**: `onConflictDoNothing` on join rows,
  insert-if-absent stamping, content-addressed dedupe at two levels (blob
  and document row).
- **Dynamic imports inside handlers** keep server-only modules out of the
  client-imported barrel's module graph.
