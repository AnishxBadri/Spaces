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

**Registering a provider (operator, once).** Settings → Connections, as an
admin, shows one OAuth client group per provider in the code registry
(`PROVIDERS`: google, box), each with its redirect URI. Paste that URI into
the provider's console exactly as shown — it is
`<APP_URL without trailing slash>/api/connections/<provider>/callback`, so
change `APP_URL` first if the public origin is not settled — then paste the
client ID and secret back. The secret is stored as a workspace
`credential(kind: oauth_client)` beside any LLM key on the same provider
name, and is shown afterwards only as its redacted tail.

- **Google: Internal vs Testing.** A fund on Google Workspace makes the
  OAuth app _Internal_ — no verification, every user in the org. Anyone else
  runs it in _Testing_: at most 100 named test users, and refresh tokens
  expire after 7 days, so every connection asks for consent again weekly.
  Recorded in CONTEXT.md "Email / calendar ingestion".
- **Box: enterprise SSO needs admin consent.** In a Box Enterprise that
  enforces SSO, a user cannot authorize a new app alone: the Box enterprise
  admin must authorize (or allow-list) the app in the Box Admin Console
  first, or the consent screen refuses. Ask the fund's Box admin before the
  first Connect.

**The dance (decided 2026-10-07).** A connection is a data grant, never a
login: better-auth stays email-and-password only (a test reads `auth.ts`
for `socialProviders`). The two legs are core's, once, for every provider.

- **Outbound — `GET /api/connections/<provider>/start`.** Query:
  `product` (required, D66: `drive` · `calendar` · `gmail` under google,
  `box` under box), `scopes` (comma-separated registry `value`s; default the
  product's base set — `openid email drive.file` for Drive) and `return` (a
  same-origin path; default `/settings/connections`). No session → 401. An
  unknown provider, product or scope, a scope that belongs to another
  product, or a `return` that leaves the site → 400 naming it. No active
  `credential(kind: oauth_client)` for the provider → `ProviderUnconfigured`,
  a 409 whose text names Settings → Connections — never a redirect to a
  half-built URL. Otherwise a 302 to the provider's `authUrl` with
  `client_id`, `redirect_uri` (`<APP_URL without trailing slash>/api/connections/<provider>/callback`),
  `response_type=code`, `scope` (the registry `wire` strings, space-joined,
  exactly the ones asked for), `state`, `code_challenge` and
  `code_challenge_method=S256`; for google also `access_type=offline` and
  `prompt=consent`, without which no refresh token comes back.
- **The state** is signed, not encrypted: `<base64url(canonical JSON)>.<base64url(HMAC-SHA256)>`,
  the HMAC key derived from the master key (HKDF, label
  `spaces:connect-state`). The payload: session user id, provider, product,
  scope `value`s, return path, a nonce and `issuedAt`. Life: ten minutes.
  `verifyState` (core, `writes/connections/state`) fails `StateInvalid` with
  a reason — `tampered` (bad signature or malformed), `expired`, or
  `wrong-user` (the callback's session is not the one that started).
- **The `code_verifier` lives in a cookie, decided.** Not inside the state
  (the state passes through the provider and its logs, which would defeat
  PKCE) and not in a row (a table for a ten-minute secret, and a sweep for
  abandoned dances). The start leg sets exactly one cookie per dance:
  - name `spaces_pkce_<nonce>`, the nonce the signed state carries; value
    the verifier (32 random bytes, base64url, 43 characters);
  - `Path=` the callback's own path (`/api/connections/<provider>/callback`,
    under any path APP_URL carries), `Max-Age=600`, `HttpOnly`,
    `SameSite=Lax` (the provider's redirect back is a top-level GET, which
    Lax sends), and `Secure` exactly when APP_URL is https.
  - The callback verifies the state first, then reads the cookie the
    state's nonce names (`readVerifierCookie`) — a cookie from another
    dance is never found — and clears it (`clearVerifierCookie`, same name
    and path, `Max-Age=0`) whatever the outcome. No cookie → the dance is
    refused, as for an expired state.
  - Every later provider takes this as given; nothing re-decides it.
- **Inbound — `GET /api/connections/<provider>/callback`.** No session →
  a 401. Then, in order: `verifyState` against the session user (a bad
  signature, a state older than ten minutes, another user's state, or a
  state for another provider → 400); the provider's `error=` param → 400
  naming it; the verifier cookie the state's nonce names, missing → 400 as
  for an expired state. The code is traded at the registry's `tokenUrl`
  (`grant_type=authorization_code`, `code`, `code_verifier`, the same
  `redirect_uri`, and the `oauth_client` id and secret in the form body),
  then the account is read from `userinfoUrl` with the access token —
  google `sub` and `email`, box `id` and `login`. A refused exchange or an
  unreadable account → `ExchangeFailed`, a 502; nothing is written before
  both succeed. Then one upsert on `account_connection_unique`
  `(user_id, provider, product, external_email)`:
  - `tokens_enc` — `{ accessToken, refreshToken, tokenType }` as one JSON
    string through the vault's `encryptSecret`, AAD
    `connection:<user_id>:<provider>` (`encryptBundle`, core
    `writes/connections/bundle`); another user's AAD fails the GCM tag.
  - `scopes` — what the provider granted: the response's `scope` split on
    spaces and mapped back to registry `value`s through `wire` (Google's
    `…/auth/userinfo.email` is `email`); a response with no `scope` granted
    exactly what was asked (RFC 6749 §5.1, which is Box). Never the
    requested set.
  - `expires_at` = now + `expires_in`; `refresh_token_expires_at` = now +
    `refresh_token_expires_in` when the response carries it, else null
    (Google's Testing-mode seven days is not in the response).
  - `external_account_id` and `external_email` from userinfo; `status`
    back to `active` and `error_reason` to null, so a repeat dance revives
    an `error` row.
  - Then a 302 to the state's return path. The verifier cookie is cleared
    on every answer whose state is genuinely signed (`signedNonce`), refusal
    or success; a forged state names no cookie of ours.
- **Scopes grow incrementally, within a product (D66).** A product's
  connection is one row however many times its user consents; Drive asks
  `drive.file` first and `drive.readonly` only when a folder is bound,
  never a second account row.
  - **Ask.** `hasScopes(connectionId, scopes)` (core,
    `writes/connections/scopes`, no user, so the worker calls it too)
    answers `granted`, or `missing` listing exactly the asked-for values not
    on the row, or fails `ConnectionNotFound`. The caller sends the user to
    `connectHref(provider, product, missing, returnTo)` — the start route
    with `scopes` and `return` — and the dance ends back on `returnTo`.
  - **Start.** When the session user already holds a row for (provider,
    product) — any `external_email`, any status — the authorize URL also
    carries `include_granted_scopes=true` (Google folds the earlier grant
    into the new token; Box ignores the parameter). The `scope` param is
    still exactly the values asked for.
  - **Callback.** The upsert inserts, or on conflict locks the row and
    writes `scopes` as the union of the stored set and what this grant
    returned, in registry order — the union adds only what was granted, so
    an unticked scope never lands. `tokens_enc` is the new bundle; when the
    provider omitted `refresh_token` (a repeat consent can), the stored
    refresh token is decrypted under the same AAD and carried into it.
  - A `revoked` row's grant is gone at the provider: its scopes and refresh
    token are not carried over, and the row holds this grant alone.
- **Tests run against an in-repo fake IdP**, a node `http` server on an
  ephemeral loopback port (`startFakeIdp`, core `writes/connections/fake-idp`),
  not a container. Its `/authorize` records each query and answers 302 to
  the `redirect_uri` with a `code` and the `state`; `/token` trades a code
  once and only with the `code_verifier` whose S256 challenge `/authorize`
  recorded (400 `invalid_grant` otherwise), with a partial-grant mode that
  withholds scopes; `/userinfo` and `/2.0/users/me` answer its bearer
  tokens in Google's and Box's shapes. Both programs take the provider
  table as an argument, so a test points the URLs at it.

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
memo); `interaction_document → interaction` (an artifact: `role`
attachment, transcript or recording link — a join row, not a link); `note → document
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

**An interaction's artifacts are a join, never a column (D67, D68).** An
email's attachments (entry 6), a recorder's transcript and a meeting's
recording link are `document` rows hung off their interaction by
`interaction_document(interaction_id, document_id, role)`, `role` one of
`attachment`, `transcript`, `recording_link`, primary key on the pair. One
meeting carries many artifacts, so `interaction.document_id` is never
created; a transcript is filed like any arrival and reaches the meeting
through that row.

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

**As built — entry 7, paste a link (2026-10-07, SPA-238).** The Files tab
takes a Drive URL dropped on it or pasted in its paste row ("…or paste a Drive
link"); any other link is still saved as a page (entry 5). Web imports no
plugin code, so the link is resolved on the worker:

- `attachFromLink({ url, attachTo, returnTo })` picks the provider by host
  (`drive.google.com`, `docs.google.com` → Google, product `drive`) and the
  pasting user's own connection for it (D66): none → `connect` with the start
  route back to the record; none active → `refused` with the stored
  `error_reason`; else it enqueues `document.fetch-storage` with a per-paste
  `singletonKey` and answers `queued`. The tab polls `linkFetchStatus` by that
  key; the pending row reads "Fetching from Drive…" and, on a refusal, the
  job's reason.
- The job finds the enabled integration whose manifest on disk says
  `provides: 'storage-source'` for the provider
  (`storageSourceIntegrationFor`), builds its `storageSource` over the
  ambient ports with Secrets bound to the pasting user's connection
  (`storageSourceFor`), and calls `resolveLink`. A folder link, a non-file
  link and `NotFound` are refusals in words; `AuthExpired` carries the
  provider's reason; `RateLimited` reschedules.
- A file already held for the connection (`connection_id`, `external_id`) is
  filed on the record and never downloaded again. Otherwise `getFile` streams
  into intake: `MAX_UPLOAD_BYTES` is metered on the stream, the row is born
  `integration` with `source_ref` the integration, `external_id`,
  `external_url` (Drive's `/file/d/<id>/view`) and `connection_id`, and
  extraction is queued as for any arrival.
- `source_path` is the file's folder path as Drive shows it, root first and
  joined with " / " ("My Drive / Data room / Legal"): `StorageFile` carries
  `parentId` (Drive's `parents`, asked on the metadata call `getFile`
  already makes) and the job names it with `getFolder`. A file at a root, or
  whose folder the connection cannot see, gets null; the row's "from …" line
  renders only when it is set.

**As built — entry 7, pick (2026-10-07, SPA-246).** "Attach from Drive" sits
at the end of the Files tab's paste row, outlined. Web still imports no
plugin code and bundles no provider SDK (`scripts/check-client-bundle.sh`
fails a client chunk naming `apis.google.com` or `google.picker`):

- **Readiness, before any click.** `pickerReadiness({ provider, returnTo })`
  draws the button: Connect with no Drive connection; "Attach from Drive…"
  linking to the incremental re-consent (`connectHref(…, ['drive.file'])`)
  when the row lacks `drive.file`; "Picker not set up" when the
  `google-drive` row has no `pickerApiKey`/`pickerAppId` (an admin's links to
  `/settings/integrations/<id>`, a member's is a tooltip); a refusal in a
  tooltip otherwise. The row is found by `storageSourceSettingsFor`, which
  reads the row's stored `manifest` and `config` and never the plugins
  directory.
- **The mint.** `mintPickerToken` (POST) runs the same checks, then refuses —
  `PickerScopeTooBroad`, no token — when the connection holds anything past
  the picker set (`drive.file`, plus `openid`/`email`): a `drive.readonly`
  token in a browser is a whole-drive read credential, so the picker
  refuses rather than downgrades, and pasting a link still works. Otherwise
  `accessTokenFor` mints for this one call and the answer carries the token,
  the row's key and app id, the script URL and the views. The host keeps it
  in state for one picker and drops it on close.
- **The host** adds the script tag at click time, `gapi.load('picker')`, and
  builds a multiselect picker over My Drive and shared drives. Google's
  picker draws its own overlay; nothing of ours is styled inside it.
- **Picking n files** calls `attachFromPicker` once; it sends one
  `document.fetch-storage` per file on Drive's own `/file/d/<id>/view` link,
  each with its own `singletonKey`, so the tab shows n "Fetching from Drive…"
  rows. The job is the paste path's, so a file this connection already holds
  is filed and not downloaded again. Cancel sends nothing.
- **`SPACES_FAKE_PROVIDERS=1`.** The mint answers the fake Drive's seed
  files instead of a token, and the host draws them as an in-app pick list
  (checkboxes, Attach n, Cancel); the worker's fake API serves the fetches.

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

**As built — the read half (2026-10-07, SPA-229).** `StorageSource` in
`@spaces/sdk` (`packages/sdk/src/storage-source.ts`) types the read half;
the four write members are optional opaque placeholders until write-through
(§6), so a read-only provider type-checks. Where it differs from the sketch
above:

- **Every method returns an `Effect`** whose failures are tagged errors
  exported beside it — `NotFound { id }`, `CursorExpired { cursor }`,
  `RateLimited { retryAfterMs }`, `AuthExpired { reason }` — never a throw.
  Each method's error channel names only the ones it can raise.
- **`getFolder(folderId) → { id, name, parents }`** is new: `parents` is
  `{ id, name }[]` from the drive root to the immediate parent (empty for a
  root; a shared drive's root is a root). The binding nesting guard and
  change-subtree filtering read ancestry from it.
- **No `hash` anywhere.** An entry carries `changeToken` (the provider's
  version or modified time, compared for equality only) and `parentId`
  (null for a root); `getFile` returns `{ stream: ReadableStream<Uint8Array>,
mime, name, changeToken }` — a web stream, never a buffer, and for a
  native doc the export's mime and name. Core hashes the bytes on arrival.
- **`listFolder(folderId, { cursor?, pageSize? })`** — the page size is a
  hint the conformance suite pins at 2; `next` is absent on the last page.
- **`changes(cursor | null)`** — `null` asks for a starting cursor (no
  changes); each change is `{ _tag: 'changed', entry }` with the latest
  state, or `{ _tag: 'removed', id }`; `next` is always present.
- **`pickerConfig()`** returns a `JsonObject` — serialisable by type — and
  the suite proves no client secret or refresh token is reachable from it.
- **Manifest:** a `provides: 'storage-source'` plugin whose job `uses`
  `Facts` or `Ai` is refused by `manifestSchema` (`STORAGE_SOURCE_WITHHELD`).

The fake Drive (`makeFakeDrive`, a seeded data room with a shared-drive
root and a native Doc exporting to docx) and the happy-path conformance
suite (`storageSourceConformance`) are in `@spaces/sdk/testing`;
`docs/spec-plugin-sdk.md` §13 has the details.

**As built — the Google Drive plugin, read side (2026-10-07, SPA-236).**
`plugins/google-drive` implements the read half over Drive's v3 REST API
and nothing else:

- **How core reaches it.** `definePlugin({ manifest, jobs, storageSource })`
  — `storageSource` is a `StorageSourceProvider`: an Effect that builds the
  `StorageSource` over Http, Secrets, Log and Config, which the host
  provides bound to the row. The type requires it when the manifest says
  `provides: 'storage-source'` and refuses it otherwise. The token is
  `Secrets.accessToken()`, fetched per call.
- **Bytes stream.** The Http port gained `stream` (body handed over unread);
  `request` reads text and would corrupt a binary. Docs → docx, Sheets →
  xlsx, Slides → pdf through `files.export`; anything else `alt=media`. A
  Form or shortcut has no bytes and is `NotFound`.
- **`changeToken` is Drive's `version`** (else `modifiedTime`). An export is
  not byte-stable — the test exports one unchanged Doc twice: two shas, one
  token.
- **`resolveLink`** reads `/file/d/`, `/drive/folders/` (shared drives
  included), `/open?id=` and the editor forms `/document/d/`,
  `/spreadsheets/d/`, `/presentation/d/` (with `/u/<n>/`), then asks Drive
  what the id names; anything else is null.
- **`changes` reads every drive the connection sees.** The cursor is one
  page token per drive: My Drive's `changes.list` sends no `driveId`, no
  `corpora` and no all-drives flag; each shared drive's sends `driveId`,
  `includeItemsFromAllDrives` and `supportsAllDrives`. A shared drive that
  appears starts at now; a 410 (or a vanished drive) is `CursorExpired`. A
  token that may not list shared drives (`drive.file`) reads My Drive only.
- **Failures.** 401 and scope 403s → `AuthExpired`; Drive's 429 and
  rate-limit 403s → `RateLimited` with `Retry-After`; 5xx and a dropped
  connection → `RateLimited` at a 5 s floor; 404 and other 403s →
  `NotFound`; a request Drive calls malformed is a defect.
- **`pickerConfig`** names the script, the scope (`drive.file`) and the
  views — no token, no secret — and asks Drive's `about` first, so a
  refused connection is `AuthExpired` rather than a picker that cannot open.
- **Fake and demo.** `makeFakeDriveApi()` in `@spaces/sdk/testing` answers
  the v3 endpoints over a `FakeDrive` (its toggles drive the HTTP answers,
  every request is recorded); the plugin passes `storageSourceConformance`
  and `storageSourceChaos` (with the 200 MB scan streamed through
  `alt=media`) against it. `SPACES_FAKE_PROVIDERS=1` stands it in for
  `google-drive` with a fake access token, which also satisfies the
  loader's `requires.connection`. `scripts/sandbox.ts` runs the conformance
  suite against a real Drive, opt-in, not wired into CI.

**As built — the write half (2026-10-10, SPA-239).** Typed in
`StorageSource`, optional there and required on `WritableStorageSource`;
`plugins/google-drive` implements it; nothing in core calls it yet.

- **`ensureFolder(rootId, path) → folderId`** — the sketch's `path` is
  relative to a root (the bound folder or the mirror root), split on `/`
  with empty segments dropped. Lazy: a segment is created only when absent.
  **Concurrency:** Drive permits duplicate folder names, so the plugin
  resolves rather than locks — after creating, a caller re-reads the name and takes
  the oldest (`createdTime`, then id; Drive's ids are not ordered), and a
  loser deletes its own folder unless something was filed in it. A lock
  would hold only inside one worker process.
- **`putFile(folderId, name, { stream, mime, sha256 }) → { fileId,
revisionId, name }`** — `sha256` is core's hash of the bytes, which the
  collision policy (§5.6) compares with Drive's `sha256Checksum`: a file
  under the name with the same sha gets a new revision; otherwise
  `collisionName` tries `name (2).ext`, `(3)`, by the same rule, so the
  `(2)` bytes put again are a revision of `(2)`. `name` reports the one
  used. Drive's upload is resumable in 8 MiB chunks, one held at a time;
  the metadata mime is the upload's own, so nothing is converted to a
  native Doc. The Http port gained byte bodies (`Uint8Array`) for it.
- **`move(id, folderId)` and `rename(id, name)`** read the item first and
  send nothing when it is already there or already so named: a replay is a
  no-op with the same `changeToken`, not an error. A move removes the old
  parent (Drive refuses a second).
- **Conformance.** `storageSourceWriteConformance({ make, fixture })` beside
  the read suite: `A/B/C` twice is one chain and one id; four concurrent
  `ensureFolder('A/B')` leave one `B`; identical bytes are a revision,
  different bytes `(2)`; a docx stays a docx; replayed `move`/`rename`
  change nothing; a missing id is `NotFound`. The fake Drive's writes are
  atomic; the fake API's folder create never looks for a namesake, so the
  plugin meets the trap for real (`FakeDrive.tree` shows the one chain).

**As built — the Box plugin, read side (2026-10-16, SPA-295).**
`plugins/box` implements the read half over Box's content API through the
same port; core is unchanged.

- **Shapes.** Ids are digits under the root `0` ("All Files"); `getFolder`
  reads `path_collection`. Box sends no mime type, so a file's is read from
  its extension (a folder lists as `application/vnd.box.folder`, a Box Note
  as `application/vnd.box.boxnote`). `changeToken` is Box's `etag`; `sha1`
  is never surfaced.
- **Listing.** `folders/:id/items` with marker paging and explicit `fields`.
  Box lists folders, then files, then web links: a web link is skipped and
  the first one ends the listing.
- **Bytes.** A file streams through `files/:id/content`'s redirect to a
  pre-signed download, which is fetched without the token. A Box Note is
  read as its `extracted_text` representation, `text/plain`, named
  `<note>.txt` — stable text, so it hashes the same every read. A
  representation still rendering after one status check is `RateLimited`
  at 5 s; one Box cannot extract is `NotFound`.
- **`changes` is the events stream** (`stream_type=changes`; Box has no
  per-folder delta). The cursor is Box's `next_stream_position`, read from
  the response text because it is a 64-bit integer `JSON.parse` would round.
  A trash is a removal; the latest event per item wins. A position Box no
  longer holds (400/404/410) is `CursorExpired`, and the poll's re-list path
  runs as it does for Drive.
- **Tokens.** Box's refresh token is single-use; `accessTokenFor` already
  stores the rotated one inside its row lock, so two concurrent calls make
  one refresh. The fake's token response carries no
  `refresh_token_expires_in`, as Box's API reference lists none, so there the
  60-day inactivity lapse shows only as an `invalid_grant` that marks the
  row `error`.
- **Fake and demo.** `makeFakeBoxApi()` in `@spaces/sdk/testing` answers the
  content API, events, downloads and OAuth (authorize, a rotating token
  endpoint, revoke, `users/me`); the plugin passes `storageSourceConformance`
  and `storageSourceChaos` against it. `SPACES_FAKE_PROVIDERS=1` stands it in
  for `box`.

**As built — the Box plugin, write half (2026-10-16, SPA-299).**
`plugins/box` implements `ensureFolder`, `putFile`, `move` and `rename`
and passes `storageSourceWriteConformance` on the fake Box; nothing under
core's sync walk, `resolveItem`, the change poll or the exporter changed.

- **Names are unique in a Box folder, ignoring case.** So `ensureFolder`
  never looks first: it `POST`s `folders`, and a 409 `item_name_in_use`
  names the folder already there — the one a racing call made — so four
  concurrent calls end with one folder and one id. A file in the way of a
  folder is a defect.
- **`putFile` is one multipart upload** to `upload.box.com` (`attributes`,
  then `file`), holding the whole file, at most 50 MB: Box's chunked
  sessions need the size up front, and a `StorageUpload` stream does not
  carry it. The collision check (§5.6) reads the folder once and compares
  Box's `sha1` with the plugin's own SHA-1 of the bytes — Box keeps no
  SHA-256 — which also goes up as `content-md5` for Box to verify. Same
  bytes are a new version (`files/:id/content`); anything else tries
  `name (2).ext`. An upload that loses the name to a racing one is judged
  again against the winner the 409 names.
- **`move` and `rename`** are `PUT files/:id` or `folders/:id`, sent only
  when the parent or name differs; a replay sends nothing.
- **Scope.** The manifest still asks `root_readonly` at install;
  `root_readwrite` (already in the registry) is for a binding that pushes,
  asked for then — as Drive asks `drive.readonly` only at bind.
- **The proof.** `FAKE_BOX_SEED` holds the fake Drive's fourteen data-room
  files under the same folders (the memo a Box Note), and
  `sync-box-live.test.ts` binds that room to a deal: the same fourteen
  documents, with `source_path`, `external_id` and `binding_id`, and a
  re-run files none. The enterprise-SSO admin consent a Box-first fund
  needs before its first Connect is in §1, beside Google's Internal vs
  Testing.

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
    parent is a space               → match-only resolve (company, {name: folder.name}),
                                      never a create
                                        identity/exact match → that company
                                        fuzzy only           → suggestion; files stay on the space
                                        no match             → stays on the space
    parent is a company             → name matches one of its deals → that deal
                                      else kind folder (§5.4)      → parent, kind preset
                                      else                          → parent
    parent is a deal                → kind folder → deal + kind; else deal
  file:
    hash → blob (sha already filed on target → attach, never duplicate)
    document row { kind: folder rule → else filename → else 'other',
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
through `resolveEntity`'s match-only twin, `previewResolveByName`: the same
identity lookup, then an exact normalised name, then the dedupe sweep's
similarity read for candidates — and nothing written, since `resolveEntity`
itself creates on no match. A typo lands as a suggestion, not a company. A
deal under a company matches on its exact normalised name only; a near miss
falls through to the kind rules.

**The kind is decided at filing time and never by a model.** `resolveItem`
is pure: the nearest kind folder (§5.4), else the filename
(`guessDocumentKind`), else `other`. A storage source never calls `Ai`
(spec-ai-substrate §11): whatever is still `other` after extraction gets the
classify lane's `document_kind` suggestion from `document.extracted`, as a
browser upload does. An empty folder creates nothing — only files
trigger. `source_path` is kept verbatim so the UI can say "from Data room /
Legal" and the mirror can write back to the same place. Retrieval scopes by
`entity_space` and ltree, **never by path** — the tree is a projection, the
graph is the meaning.

### 5.4 Kind folders

A small dictionary, case-insensitive, matched on the folder's whole name
(`guessKindFromFolder`, beside `guessDocumentKind`, its vocabulary
`DOCUMENT_KINDS`): `deck · pitch → deck` · `legal · contracts · docs →
legal` · `financials · dd · diligence · data room → dd` · `cap table ·
captable → cap_table` · `press · articles → article`. "Data room" is `dd`;
"Ohmium Data Room" is not a kind folder. Fallback: the filename's kind, else
`other` — then, after extraction, the classify lane's `document_kind`
suggestion on `document.extracted` (spec-ai-substrate §11), never a model
call at filing time.

### 5.5 Whose token, and failure

A binding runs on the binder's connection. Binder leaves or revokes →
binding `status: error`, documents already copied stay, Today shows it, an
admin re-binds with their own connection. This is why copy-in matters
(§7). Errors increment the plugin's breaker like any job; the binding pauses,
never the worker.

**As built — token custody (2026-10-07, SPA-228).** One accessor,
`accessTokenFor(connectionId)` (core, `writes/connections/token`), takes no
user and is what `Secrets.accessToken()` delegates to on the bound row's
`connection_id`; no plugin holds a refresh token or a client secret.

- **Refresh under a row lock.** One transaction: `SELECT … FOR UPDATE` on
  the `account_connection` row, then decide on what the lock re-read. More
  than 60 s left → the stored token. Otherwise `grant_type=refresh_token`
  at the registry's `tokenUrl` with the `oauth_client` credential, and the
  new bundle written back (a rotated refresh token replaces the old, else
  the old stays), with `expires_at` and, when sent,
  `refresh_token_expires_at`. A concurrent caller in another process waits
  on the lock and returns the winner's token: one token request, one live
  refresh token, proven with two db clients on separate pools.
- **Failures are typed.** A 4xx naming an error (429 aside) → row `error`,
  `error_reason` the provider's `error: error_description`, scopes and
  bundle untouched, `AuthExpired`. No answer, a 5xx or no OAuth client →
  `ProviderUnavailable`, nothing written. An `error` or `revoked` row →
  `AuthExpired` without a provider call. `Secrets.accessToken()` reports
  all of them as `NotConnected` with the reason.
- **Revoke.** `revokeConnection` (core, `writes/connections/revoke`) POSTs
  the refresh token (else the access token) to the registry's `revokeUrl` —
  Box also gets the client id and secret — under the same row lock, then
  sets `revoked`. A 4xx is logged and answered `already-revoked`; no answer
  or a 5xx fails `ProviderUnavailable` and leaves the row. Disconnect calls
  it, then deletes the row.
- **The session user's hand on it** is two server fns, `refreshConnection`
  (forces a refresh) and `revokeConnection`, each answering 'Not your
  connection' for any id that is not the caller's.

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

**As built — bound folders (2026-10-16, SPA-294).** The mirror root is not
built. An arrival writes through only when it is a person's upload —
`source_class = 'manual'`, bytes, no page address, no provider copy — so an
integration arrival, a clip or a capture on a bound record exports nothing,
pending the ping-pong decision. Birth stamps the oldest `push`/`both` folder
binding on the upload's targets as `binding_id`, in its own transaction, and
sends `storage.export` keyed by the document. The job uploads into the bound
folder itself (no kind subfolder) and records `external_id`, the URL, the
connection, `linked`, `source_path` and the upload's `changeToken` (an
optional member of `putFile`'s answer; Drive's `version`, Box's `etag`), so
the next poll's change for it is the equal-token no-op and reads nothing.
"Whose token" is the binding's connection; no usable connection is a retry
with backoff (60 s doubling to an hour, 30 retries, about a day), and Today's
notices band counts the uploads on a pushing binding still without a
pointer, by provider ("3 files waiting for a Drive connection"). An exported
upload re-filed in the app off its binding's record onto a record with a
pushing binding on the same connection is moved there and its pointer
follows; re-filed anywhere else it stays where it is, bound as before. Its
provider name follows `document.filename` whenever the job runs; no in-app
writer of a document's filename exists yet. Delete is §8's row.

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

**As built (SPA-238):** a pasted file is copied in through intake like an
upload — the bytes are ours, the pointer is `external_id` + `external_url` +
`connection_id`. A second paste of the same file through the same connection
re-files the held copy and reads no bytes; the retain policy above is the
binding's and does not apply to a pasted file, which is always `full`.

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

**As built (SPA-228):** "token revoked" reaches a job as `NotConnected` from
`Secrets.accessToken()` once a refresh is refused — the connection row is
already `error` with the provider's reason by then. Marking the binding
`error` from it is the binding's (§5.5).

**As built — the modified row (2026-10-16, SPA-288).** The revision id is
the port's `changeToken`, stored on the row as `document.external_revision_id`
at birth (the token `getFile` read the bytes at). The poll compares it with
the change's token: equal is no change and reads nothing — which covers an
unchanged Doc whose export is never byte-stable, and our own export seen
again. A different token downloads; the same bytes only store the token,
new bytes advance the row (a compare-and-set on sha and token), write the
prior `(blob_sha, external_revision_id)` to `document_revision` and re-send
extraction. Only a document a live binding brought is revised. The prior
bytes stay: `blobIsReferenced` counts `document_revision.blob_sha`, and
deleting a document reclaims its revisions' bytes once nothing else names
them. Two edits between polls are one advance — the feed reports the latest
state and the port has no revision list.

**As built — the renamed / moved row (2026-10-16, SPA-290).** A held file
whose folder or name differs from its row, inside its own binding's
subtree, advances `source_path` and `filename` in place (the record's name
follows unless a person renamed it): no edge, no new row, no extraction. The
old folder target is the stored `source_path` folded through the same
`resolveItem` steps as the new one; when the two differ, a
`refile_document` suggestion names the document and both records, proposed
in the same transaction as the advance and once per (document,
destination) unless accepted. Accept moves the edge by the accepter; a
document no longer on the old record refuses and the row stays open. A
binary's new token is still compared by sha; a renamed native document
stores its token without reading an export. The walk treats its own held
files the same way, so a re-sync never re-files what a person moved. A
near-missed folder (§5.3) proposes each file it filed to the closest
company through the same kind. Not handled: a folder rename or move (the
feed reports the folder, not its files, so their paths go stale until each
changes), and a move between two bindings or out of every binding.

**As built — the deleted row, and a move out of every binding (2026-10-16,
SPA-293).** A removal on the feed (deleted, trashed or unshared) marks the
document held for `(connection, external_id)` `external_status: gone`; so
does a live binding's held file whose new folder chain reaches no bound
folder on the connection — the row this table left open, decided the same
way, since a file that silently stopped tracking while its row still read
synced would be worse. Ours is kept whole: the row, `binding_id`, the blob,
chunks and edges, so it previews and searches from our copy and the Files
row shows `■ gone`. Nothing is deleted at the provider and nothing is
proposed. Gone is one way: every held-file write (claim, attach-stamp, move,
revise) skips a gone row, so a later page or a re-sync walk naming the same
file — even moved back into the folder — files nothing and flips nothing. A
move into another binding's subtree is still only revised.

**As built — the deleted-in-app row, and the cursor expired row (2026-10-16,
SPA-296).** §6's "marks the pointer stale" is superseded by this table's
"delete ours": deleting a bound document removes our row and writes
`storage_tombstone(binding_id, external_id, at)` in the delete's own
transaction (the entity delete executor, so every delete of a document
does it). Nothing is sent to the provider. The filer — the walk's and the
poll's one new-file path — skips an external id tombstoned for its binding,
so neither a later change on the feed nor a re-list brings it back. The 410
re-list is one `storage.sync` per binding: idempotent on
`document_connection_external_unique` for rows that exist, on the tombstone
for rows deleted here, and on `gone` for rows that stopped tracking.
Tombstones reference the binding and cascade with it, so unlinking and
re-binding the folder is the deliberate way back: the file is filed as new.

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
2. ~~`document.origin` collapses into `source_class` + `source_ref` with the
   other vendor-named enums~~ — **landed 2026-09-19 (SPA-137, migration 0030)**, after SPA-118 did the same to `entity`/`entity_alias` (0029).
   `drive`, `box`, `gmail_attachment` are `integration` + a ref, never enum
   values; `upload`, `url` and `clip` are all `manual`, because a person
   choosing a file or a page in a surface we ship is not an integration
   (CONTEXT.md "Plugin architecture" → first-party channels). Existing rows
   backfilled to `manual`: no integration row predates the `integration`
   table, so no historical row can honestly carry a ref.
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
  - "Attach from Drive" is built (§3.1, entry 7 pick): outlined, at the end
    of the paste row; it reads Connect Drive, "Attach from Drive…" (a
    re-consent, explained in a tooltip) or "Picker not set up" in the states
    that cannot open the picker yet.
- Space page Sources: same two links; bound folder shown as a source.
- `/documents`: `source` column, filter by provider; unfiled filter.
- Settings → Connections (per user): connections, their bindings, status,
  last sync, unlink; on the same page, for an admin only, the Google / Box
  OAuth apps (no separate Providers page).
  - A band per provider; under it one row per (product, account), D66: the
    product's mark, the account email, the product's granted scopes as mono
    chips (registry `value`s; `openid` and `email` are left out), the
    stored provider reason inline when the row is `error`, last sync
    (`last_sync_at` — "never synced" until a sync writes it; there is no
    "last used"), and the status word (`active` · `error` · `revoked`).
    A product with no row keeps Connect.
  - Actions: Refresh (a forced refresh) on an active row, Reconnect on an
    error or revoked one, Disconnect on every row.
  - A member sees only their own rows: `listConnectionsFor(userId)` takes
    the session user and selects no `tokens_enc`.
  - A provider with no OAuth client says "Ask an admin to configure
    Google" in its band; an admin gets a link to the client group below.
  - **Disconnect = revoke, then delete the row.** A 4xx at the provider is
    `already-revoked` and logged; an outage is logged and the row is
    deleted anyway — a provider that already forgot the grant cannot strand
    it. In the same transaction `document.connection_id` and
    `integration.connection_id` go null for that row (the files stay; the
    plugin answers NotConnected until it is bound again), since neither
    foreign key cascades.
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
  **As built:** the read half's chaos list is `storageSourceChaos` in
  `@spaces/sdk/testing`, beside the happy-path suite, run against the fake
  Drive with no network and no Postgres: each bad day a typed failure
  (`RateLimited` carrying the `Retry-After` hint, `NotFound`,
  `CursorExpired`, `AuthExpired`), half a batch read without losing the
  good half, a replayed change page deep-equal, and a 200 MB file hashed
  as it streams under a stated memory bound. The Docs export is in the
  happy-path suite; "webhook delivered twice" waits for the push channel.
  docs/spec-plugin-sdk.md §13 has the detail.
