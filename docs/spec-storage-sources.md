# Spec: documents and storage sources

Consolidates the 2026-09-14/15 design deliberation on documents, the blob
backend, and Drive/Box-class storage sources. This is the buildable spec:
what a document is, how bytes arrive, how a user's own object storage maps
onto the entity graph, and what the AI substrate takes from it.

**Scope boundary.** The blob backend (local FS default, S3 opt-in) is locked
in CONTEXT.md "Storage" — re-argued 2026-08, not relitigated here. The plugin
contract (ports, kinds, manifest, loader) lives in `docs/spec-plugin-sdk.md`;
this spec defines one kind (`storage-source`) and the core-side pipeline it
feeds. The AI substrate is `docs/spec-ai-substrate.md`; §10 here says only
what storage adds to it.

## 1. Three layers, one pipeline (decided 2026-09-14)

Three things get conflated under "storage"; they are separate and they
coexist.

| layer                      | what                                                                  | owner                       |
| -------------------------- | --------------------------------------------------------------------- | --------------------------- |
| 0 · blob backend           | where bytes _we own_ live. `STORAGE_DRIVER=local \| s3`               | operator, at deploy         |
| 1 · storage sources        | where _their_ files already live. Drive, Box, Dropbox, OneDrive       | users, any time, per source |
| 2 · suites (Workspace/365) | not a kind. A **provider** (one OAuth app) under which N plugins hang | operator registers once     |

Layer 0 is not an alternative to layer 1. Every file, from every source,
ends in layer 0. The only operator choice about layer 0 is disk vs bucket;
end users never meet it. Drive as a _backend_ is rejected: no presigned PUT,
no checksum enforcement, no content addressing.

**Google Workspace ≠ Google Drive.** "Integrate Workspace" = the operator
registers the Google provider (client id/secret in the vault, redirect URI
from `APP_URL`). "Integrate Drive" = a user consents to the Drive scope under
it. Login (OIDC), Gmail (`syncer`), Calendar (`syncer`), Drive
(`storage-source`) are four consents on one provider. Box is a provider with
exactly one plugin. Same machinery, different fan-out. The OAuth dance
(PKCE, refresh, encryption, revocation) is core, once, per provider; plugins
declare `requires.connection: { provider, scopes }` and never implement it.

**Coexist by role, decided:** Drive/Box = the fund's archive and
collaboration surface, also an arrival channel. Our blob + derived layers =
the index and the AI working set. Bytes-of-record: Drive when a mirror is
bound, ours otherwise. **Graph-of-record: always ours.**

## 2. What a document is (exists)

Bytes the user did not author in the app, plus what we extracted from them.
Entity (`kind: document`) so it is mentionable, searchable, linkable; side
table:

```
document(entity_id, blob_sha, filename, mime, size_bytes, url,
         kind: deck | dd | cap_table | legal | article | other,
         origin → source_class + source_ref (§11),
         extracted_text, tsv, extraction_status: pending | done | unsupported | failed,
         extraction_error, extracted_at, uploaded_by, created_at)
```

No page of its own: opens in the preview modal, routes to whatever it is
filed against. Never edited in-app. No visibility flag — documents are
workspace-visible (private documents deferred, §13).

Same three axes as notes, plus two of its own:

| axis           | mechanism                                           | values                                                                                      |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **where**      | `link(tagged_in → record)` · `entity_space` (space) | zero or more                                                                                |
| **what** genre | `document.kind`                                     | six values, held (§11 drops `memo`)                                                         |
| **who**        | none                                                | workspace                                                                                   |
| **provenance** | `source_class` + `source_ref`                       | manual · integration(drive/box/gmail…) · ai · import · seed · merge · extracted · inherited |
| **state**      | `extraction_status`                                 | four values                                                                                 |

Edges a document participates in: `tagged_in → record` (filed, the act);
`entity_space` (a _source_ for a space); `derived_from → note` (exported
memo); `derived_from → interaction` (transcript); `note → document
(mentions)` (`[[Ohmium deck]]`); future `document → term (mentions,
extracted)` (concept links). `document_chunk` carries embeddings (§9).

## 3. The documents feature, distilled (decided 2026-09-14)

**The fund's object storage, indexed by the graph instead of by path.**
Three questions define it.

### 3.1 Entry points — how bytes get in

| #   | where                         | gesture                                         | filed as                                                 | status      |
| --- | ----------------------------- | ----------------------------------------------- | -------------------------------------------------------- | ----------- |
| 1   | record page (any object)      | drop on Files tab, "Upload"                     | `tagged_in → record`, kind chosen inline                 | built       |
| 2   | space page                    | drop into Sources, "Add source"                 | `entity_space → space`                                   | not built   |
| 3   | global                        | `/documents` "Upload", `+` menu, Cmd-K "upload" | picker: record / space / leave unfiled                   | not built   |
| 4   | note editor                   | drop a file into the body                       | filed where the note is filed + `[[mention]]` at cursor  | not built   |
| 5   | paste a URL                   | any upload box                                  | `source_class: manual`, readability clip or PDF snapshot | deferred    |
| 6   | email forwarding              | attachments                                     | matched company, else unfiled                            | integration |
| 7   | Drive / Box                   | pick · paste link · bound folder (§5)           | copy-in, pointer kept                                    | this spec   |
| 8   | API / capture extension / MCP | `POST /api/documents`                           | as declared                                              | later       |
| 9   | memo export                   | "Export PDF" on a memo                          | `derived_from → note`, filed where the memo is           | later       |

All nine converge on one server path: **hash → blob → `document` row →
edges → enqueue extract.** Presigned PUT; bytes never stream through Node.
The path exists; 2–4 are UI on top of it.

**Provenance on these rows, corrected 2026-09-19 (SPA-118, decision D1).**
This table originally wrote a per-entry word into `source_class` — `url` for
entry 5, and §5.3 below wrote `source_ref: binding.connection_id` for entry 7. Both were drafting errors and neither is representable. `source_class` is
the eight-value class enum (CONTEXT.md _Plugin architecture_;
`docs/spec-plugin-sdk.md` §8) and `source_ref` **always references
`integration.id`**, FK enforced, null unless the class is `integration` — a
check constraint on each table enforces both halves. So of these nine
entries: 1–5 and 9 are `manual` (a person in the app; the capture extension
at 8 too, since it is first-party and a clip is a human clicking a button),
6 and 7 are `integration` + the id of the integration that owns the mailbox
or the binding, and "whose account" is one hop further on through
`integration.connection_id` / `document.connection_id` /
`storage_binding.connection_id`. Nothing in this spec ever puts a vendor
name in a shared enum, which is the whole reason the collapse exists.

### 3.2 Surfaces — where you see them

| surface               | shows                                                                                 | status              |
| --------------------- | ------------------------------------------------------------------------------------- | ------------------- |
| record Files tab      | documents `tagged_in` this record, grouped by kind                                    | built               |
| space Sources section | documents filed into the space + documents on companies in the space (collapsed)      | not built           |
| `/documents`          | record-table engine: kind · filed against · space · source · extraction · date; views | not built, nav item |
| Cmd-K                 | hits in extracted text, snippet, routes to the record                                 | built               |
| preview modal         | PDF / image / office-as-text, download                                                | built               |
| unfiled inbox         | documents with no edge; badge on Today                                                | not built           |
| note body             | `[[deck]]` mention chip → preview                                                     | built               |

### 3.3 Actions on a document

preview · download · re-file (add/remove record or space edges) · change
kind · delete (real; GCs the blob if unshared) · re-extract · "open in
source" (Drive/Box/email when the source has one) · mention from a note.

### 3.4 Rules that make it storage and not a folder tree

- Same bytes uploaded twice = one blob, one row when the sha is already
  filed on the target; otherwise one blob, two rows, both filed where they
  were dropped.
- A document can be filed in N places. The deck lives on the company _and_
  the deal without copying.
- Kind is a genre, not a folder. Six values, held; an added value is
  questioned the way a fourth note kind is.
- No nesting, no folders, no drag-to-folder. Kind + filed-against + space
  are the three axes a fund's folder tree encodes; views cover the rest.
- Delete is real. Misfiled uploads must be removable.
- Build order to call it complete: space filing → `/documents` → global
  upload + unfiled inbox → drop-into-note → URL clip. None needs Drive.

## 4. The `storage-source` port (decided 2026-09-14)

One port, N providers. Drive and Box implement it; Dropbox/OneDrive later.
Core never knows which.

```ts
interface StorageSource {                       // sdk kind: 'storage-source'
  resolveLink(url)      → { fileId } | { folderId } | null
  listFolder(folderId, cursor?) → { entries: [{ id, name, kind: file|folder, mime, size, modifiedAt, hash? }], next? }
  getFile(fileId)       → { stream, mime, name, hash? }
  changes(cursor)       → { entries, next }     // delta API where the provider has one
  pickerConfig()        → what the web needs to open the provider's native picker
  // write-through (§6)
  ensureFolder(path)    → folderId
  putFile(folderId, name, stream) → { fileId, revisionId }
  move(fileId, folderId) · rename(fileId, name)
}
```

The plugin delivers bytes and reports changes. It **never decides filing**
(§5.3 is core) and **never calls `Ai`** — core's `document.extracted` event
fires core features. Per-user OAuth (`account_connection`); the `Secrets`
port hands a fresh access token at job time. Bytes are hashed on arrival,
always — no provider hash is trusted across providers.

Provider differences, contained in the plugin: Drive uses `changes.list`
page tokens and must _export_ native Docs/Sheets (`docx`/`pdf`/`xlsx`; hash
the export); shared drives and My Drive both work. Box uses the events
stream or `folder/items?sort=date`; Box Notes export; enterprise SSO consent
is admin-gated (docs say so).

## 5. Bindings — pointing a folder or file at a node (decided 2026-09-14)

### 5.1 The table

```
storage_binding(id, connection_id, provider, folder_id | file_id, folder_path,
                target_entity_id,           -- space | company | deal | custom record
                grain: folder | file,
                direction: pull | push | both,
                retain: full | text,
                map_subfolders bool,
                sensitivity: inherit | sensitive,
                is_mirror_root bool,        -- at most one per workspace
                cursor, last_synced_at, status: active | error | paused, error)
```

A binding = "this folder over there _is_ this node over here." No binding =
no sync, ever. We never mirror a whole Drive.

### 5.2 Two grains

**Folder binding.**

| our node  | their folder                 | meaning                                                         |
| --------- | ---------------------------- | --------------------------------------------------------------- |
| deal      | `Ohmium Series B/` data room | every file is this deal's document; subfolders → kind           |
| company   | `Ohmium/`                    | company files; a subfolder named like a round maps to its deal  |
| space     | `Research/Hydrogen/`         | sources; child folders named like companies → `resolveEntity`   |
| workspace | one mirror root              | projection `Space/Company/Deal/Kind/` maintained both ways (§6) |

Set from the Files tab or space page: "Link a Drive folder" → provider
picker → options (`map_subfolders`, `retain`, `direction`, `sensitivity`).

**File binding.** Two flavours:

- **Pick once** (static): the picker on any Files tab. Copy bytes, keep the
  pointer. Most decks.
- **Live file** (followed): "Link and follow" on a Sheet or shared Excel.
  Each provider revision → new blob, `document.blob_sha` advances, the prior
  sha is kept in `document_revision(document_id, blob_sha, external_revision_id,
at)`. Cap tables, MIS sheets, models. Drive already versions; we mirror
  revisions instead of files. One direction: Drive → us; editing happens
  where the editor is.

### 5.3 `resolveItem` — the mapping algorithm

```
resolveItem(item, parentTarget):
  folder:
    map_subfolders off              → same target as parent
    parent is a space               → resolveEntity(company, {name: folder.name})
                                        identity/exact match → that company
                                        fuzzy only           → suggestion; files stay on the space
                                        no match             → stays on the space
    parent is a company             → name matches one of its deals → that deal
                                      else kind folder (§5.4)      → parent, kind preset
                                      else                          → parent
    parent is a deal                → kind folder → deal + kind; else deal
  file:
    hash → blob (sha already filed on target → attach, never duplicate)
    document row { kind: folder rule → else classify lane → else 'other',
                   source_class: integration, source_ref: integration.id,
                   connection_id: binding.connection_id,
                   external_id, external_url, source_path }
    edges: tagged_in → record  |  entity_space → space
    enqueue extract
```

**`source_ref` corrected 2026-09-15, landed 2026-09-19 (SPA-118).** This
block first wrote `source_ref: binding.connection_id`; that was the drafting
error. `source_ref` always
references `integration.id`, FK enforced, null unless `source_class =
'integration'` — CONTEXT.md _Plugin architecture_ and `docs/spec-plugin-sdk.md`
§8. "Whose account" is one hop away through `document.connection_id` /
`storage_binding.connection_id` / `integration.connection_id`. Carried by slice
`clean-3` in `docs/roadmap-2026-09.md`, which landed the pair on `entity` and
`entity_alias`; `document.origin` follows (§11, item 2).

**Folder names are hints, never identity.** A folder called "Ohmium" goes
through the same `resolveEntity` every creator uses; a typo lands as a
suggestion, not a company. An empty folder creates nothing — only files
trigger. `source_path` is kept verbatim so the UI can say "from Data room /
Legal" and the mirror can write back to the same place. Retrieval scopes by
`entity_space` and ltree, **never by path** — the tree is a projection, the
graph is the meaning.

### 5.4 Kind folders

A small dictionary, case-insensitive, matched on the folder name:
`deck · pitch → deck` · `legal · contracts · docs → legal` ·
`financials · dd · diligence · data room → dd` · `cap table · captable →
cap_table` · `press · articles → article`. Fallback: the `classify` lane
on the first 2k chars, gated on an LLM key; else `other`.

### 5.5 Whose token, and failure

A binding runs on the binder's connection. Binder leaves or revokes →
binding `status: error`, documents already copied stay, Today shows it, an
admin re-binds with their own connection. This is why copy-in matters
(§7). Errors increment the plugin's breaker like any job; the binding pauses,
never the worker.

### 5.6 Conflicts, decided

- Same file in two bound folders → one blob, two documents, filed in both.
- File moves between two bound folders → re-file as a **suggestion**, never
  silent.
- Binding a folder inside another binding (parent and child both bound) →
  refuse the second with a message. One folder, one owner node.
- Name collision at a projected path on write-through → provider revision if
  same sha, `(2)` suffix if different.

## 6. Write-through (decided 2026-09-15, revising "no write-back in v1")

Drive-first funds treat Drive as the archive; a CRM that swallows uploads
fragments it. Write-through is in scope and cheap because the projection
already exists.

**Two modes, operator picks one.**

1. **Bound folders** (`direction: push | both`): an upload on that record in
   the CRM lands in our blob _and_ in that folder. Unbound records stay
   CRM-only.
2. **Mirror root** (`is_mirror_root`): one folder bound at workspace level;
   every upload anywhere lands at its projected path
   `Space path / Company / Deal / Kind / filename`. The user never binds per
   record; Drive fills itself with the tree they would have built by hand.

Both: our blob still holds the copy. We are the index, Drive is the archive.

**Semantics.**

- Upload in app → blob → row → `plugin.<provider>.export` job →
  `ensureFolder` (lazy — a folder is created when its first file lands, never
  on deal/company creation, no empty-folder sprawl) → `putFile` →
  `external_id` recorded.
- **Loop prevention:** the `changes` poll sees our own export; match on
  `external_id` → no-op. Every Drive-side write is idempotent on
  `external_id`.
- Re-file in app (deal moved to another company) → `move` to the new
  projected path. Rename in app → `rename`.
- Delete in app → **never** deletes in Drive. Marks the pointer stale.
- Drive disconnected / binder gone → export job queued, retried; Today:
  "3 files waiting for a Drive connection." Never silently dropped.
- Whose token: the uploader's connection if they have one for that
  provider; else the mirror owner's; else queue.
- Google Docs (native) are imported via export; write-through never
  converts uploads into native Docs.
- Not mirrored: notes/memos (not documents; a memo's PDF export is a
  document and _does_ flow).

## 7. Copy-in, not reference (decided 2026-09-14)

Bytes are always copied for anything filed. The argument, once:

| need                                                  | reference-only            | copy-in |
| ----------------------------------------------------- | ------------------------- | ------- |
| extraction, search, dedupe, AI context                | no (must download anyway) | yes     |
| survives revoked token / moved file / partner leaving | dead link                 | yes     |
| backup covers it (`tar ./data`)                       | no                        | yes     |
| "your data on your box"                               | leaks                     | holds   |
| duplicate bytes                                       | no                        | yes     |

Scale reality: decks are 5–30 MB; an active angel files 300–800 documents a
year ≈ 5–15 GB; a ten-year fund < 100 GB. Only _filed_ files are copied,
never a whole Drive, and content addressing dedupes across arrival paths.

**Retain policy per binding** — the honest middle, cheap because the pipeline
already separates bytes from text:

| retain           | keeps                                                            | preview                | search | survives Drive loss |
| ---------------- | ---------------------------------------------------------------- | ---------------------- | ------ | ------------------- |
| `full` (default) | bytes + derived layers + pointer                                 | local                  | yes    | yes                 |
| `text`           | sha + derived layers + pointer; bytes discarded after derivation | fetched live via token | yes    | derived layers only |

`text` for a 40 GB data room you will never open in-app; `full` for anything
on a deal you invested in. Flip `text → full` → backfill job. Blob GC
(delete drops the blob when no other row shares the sha) reclaims space the
other way.

## 8. Change semantics (decided 2026-09-14)

| event                                  | we do                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| new file in a bound folder             | new document via `resolveItem`                                                                                          |
| modified (hash / `modifiedAt` changed) | new blob, row advances to the new sha, prior sha → `document_revision`, old blob GC'd unless shared, extraction re-runs |
| renamed / moved inside the subtree     | `source_path` updates; filing unchanged unless it crossed a company folder → re-file **suggestion**                     |
| deleted in Drive                       | keep ours; `external_status: gone`, shown on the row. We never delete theirs                                            |
| deleted in app                         | delete ours; never touches Drive                                                                                        |
| permission lost / token revoked        | binding `error`, surfaces on Today and Connections; existing documents unaffected                                       |
| cursor expired (Drive 410)             | full re-list of the bound subtree, idempotent on `external_id`                                                          |
| our own export seen by the poll        | `external_id` match → no-op                                                                                             |

## 9. Derived layers — the storage layer as the AI substrate sees it (decided 2026-09-15)

```
blob (sha256)                                  bytes. local | s3. optional per binding (retain: text)
  ├─ extracted_text + tsv                      exists
  ├─ document_chunk(page | sheet, text, embedding, model_id)   the retrieval unit
  ├─ page images (cache)                       vision lane + preview; rebuildable
  ├─ extraction cache (kind-schema → patch, model_id, at)      re-asking is free
  └─ term links (document → term)              deterministic, concept node
```

All derived, all rebuildable, all **keyed by sha** so duplicates share them.
This is what makes `retain: text` honest: the AI only ever reads derived
layers; bytes are needed for re-derivation and preview. Chunking per format:
PDF/PPTX by page (a slide is a natural unit), XLSX by sheet then row blocks,
DOCX by heading; ~400–600 tokens, small overlap. Each chunk carries `page`,
`kind`, the space ltree path, and `sensitive` so retrieval filters before
scoring.

Embeddings are core, computed on our worker via the substrate's `embed`
lane, one pinned model per deployment, never forced on the user (no
provider → lexical + graph only; provider → automatic per document, bulk
backfill asks). Provider architecture is in `spec-ai-substrate.md`.

**Sensitivity rides the filing.** A space, record, or binding can be flagged
sensitive; documents inherit from where they are filed (a bound data room
defaults to `inherit`, settable to `sensitive`). Sensitive → local lane
(Ollama) for extract, embed, and vision, regardless of task. Decided at
ingest, not per query.

## 10. What the substrate gains from storage sources — and what it does not

| gain                                                             | use                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| volume: the whole data room, not three uploads                   | recall for "compare every deck on X"                                                                                                 |
| provenance as signal: `source_path`, folder names, which binding | weak priors for kind and for which record a chunk belongs to; ranker weights `tagged_in` from a bound data room above a loose upload |
| revisions of live files                                          | diff-driven proposals ("cap table changed → ownership 8.6%" as `round`/`mark` events into the ledger inbox); temporal questions      |
| Docs / Sheets export                                             | text from native files the fund writes in Drive, otherwise invisible                                                                 |
| sensitivity per binding                                          | routing decided at ingest                                                                                                            |
| bytes on the box                                                 | vision lane on scanned decks, re-extraction when extractors improve, re-embed on model change                                        |

What it does **not** gain: Drive's folder tree as meaning. Five of the six
things the substrate needs from a document (text/chunks/vectors, edges,
stable identity, availability at job time without a user present,
sensitivity routing) can only come from our side; Drive can never replace
our storage for anything the AI touches. Storage integration is a bytes pipe
with hints; everything intelligent happens in core after bytes land, which is
why the plugin stays ~300 lines and swapping Drive for Box changes nothing
above the port.

## 11. Schema deltas (this spec changes in code)

1. `document.source_path text`, `external_id text`, `external_url text`,
   `external_status: linked | gone | null`, `connection_id → account_connection`.
2. `document.origin` collapses into `source_class` + `source_ref` with the
   other vendor-named enums (CONTEXT.md "Plugin architecture"); `drive`,
   `box`, `gmail_attachment` become `integration` + a ref, never enum values.
3. **Drop `document.kind = 'memo'`** — a naming collision with note memos;
   an exported memo is `derived_from → note`. Six kinds remain.
4. **Documents file into spaces via `entity_space`** — the doctrine already
   said so; only `tagged_in` is written today. Closes the space-page
   "Sources section" open question.
5. `storage_binding` (§5.1), `document_revision` (§5.2). Both non-entities.
6. `/documents` view on the record-table engine; unfiled inbox (documents
   with no edge) with a Today badge.
7. Sensitivity flag on space / record / binding, inherited down; the
   substrate reads it.

## 12. UI touch points

- Files tab: "Upload", "Attach from Drive", "Link a Drive folder", per
  document "Follow this file" / "Open in Drive"; for bound folders a line
  "Synced from Drive · 14 files · 2m ago".
- Space page Sources: same two links; bound folder shown as a source.
- `/documents`: `source` column, filter by provider; unfiled filter.
- Settings → Connections (per user): connections, their bindings, status,
  last sync, unlink. Settings → Providers (admin): Google / Box OAuth apps.
- Today: binding errors, files waiting for filing, files waiting for export.

## 13. Deferred, with the reason on record

- **Box, Dropbox, OneDrive after Drive.** One port, conformance-suite
  tested; Drive first because the user base skews Workspace. Microsoft 365
  mirrors the Google provider shape when it lands.
- **Two-way for file bindings.** A followed file flows Drive → us only;
  the editor lives in Drive. Revisit only if in-app editing ever exists.
- **Eager folder creation on deal/company birth** (a toggle some
  Drive-first funds will want). Ship lazy; add when asked.
- **Private documents.** Documents are workspace-visible; a private _note_
  can mention one. A visibility flag would touch the blob route and every
  search CTE — decided only on a real ask.
- **`Range` support in the blob route / preview.** Whole file in memory is
  fine for 5–30 MB decks; a 200 MB scan is slow, known.
- **Companion-container sources** (anything with a foreign runtime) — the
  plugin-architecture companion design, deferred there.
- **Testing:** in-repo fake Drive/Box servers implementing only the port's
  endpoints (seeded data-room tree), a port conformance suite run against
  every provider plugin, cassettes for stateless APIs, real sandboxes
  nightly and opt-in. Chaos list: 429 + `Retry-After`, token revoked
  mid-sync, half a batch failing, webhook delivered twice, file deleted
  between list and get, Docs export, 200 MB file, cursor expired.
