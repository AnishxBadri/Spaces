# Backlog

Full bodies of the open slices, the repo copy of their Linear issues. Linear issues get archived once shipped, so this file is what keeps an open spec readable. Amend a body here and in Linear together. When a slice ships, delete its body here; the bodies of every shipped slice of projects 14–29 are in git at `1860d2c` (`git show 1860d2c:docs/roadmap-backlog.md`).

The Clean UI project (`SPA-349`…`SPA-356`) has its bodies in Linear only.

---

## 16. A published image anyone can run

#### `ship-10` · afk · M — Install, upgrade and rollback docs — back up first, pin the tag, never lose MASTER_KEY

**Blocked by:** `ship-3`, `ship-5`, `ship-8`

**What to build**

Three recorded decisions have no written home and all three are standing debt. README is still the TanStack Start template's ('Welcome to your new TanStack Start app!', a section on removing Tailwind, Better Auth setup notes) — the front door of a product people are meant to self-host. Write the docs the earlier slices made true, and nothing more. docs/install.md: the compose file pinned to a published tag, the two required env vars and the fact that there are only two, what ./data holds, the setup token printed to the logs, and the HTTPS overlay as step two. docs/upgrade.md: back up with scripts/backup.sh, pull, up — and the reason, which is now enforced rather than requested, because an older image refuses a newer database. The MASTER_KEY warning appears in bold in three places saying the same sentence, per CONTEXT's 'docs must say this in bold'. The ./data ownership paragraph must tell the truth after ship-2: the entrypoint repairs it, and `chown -R 1000:1000 ./data` is only needed when the container is pinned to a non-root user. Every command in these docs is run once by a human against a clean box, and no command that was not run appears.

**Acceptance criteria**

- [ ] README is the product's front door: what Spaces is, the compose quickstart pinned to a published tag, links to install and upgrade — and none of the TanStack template's remaining sections
- [ ] docs/install.md covers: compose from a pinned tag, DATABASE_URL and APP_URL as the only required vars, what lives in ./data, the first-run setup token from the logs, then the TLS overlay
- [ ] docs/upgrade.md covers: backup → pull → up; the bold statement that an older image now refuses a newer database and that the way back is restore, never a downgrade; and the psql two-liner for the dealos→spaces role/database rename
- [ ] The MASTER_KEY sentence appears in bold in install, upgrade and backup sections, identically worded: lose ./data/secret.key and every stored credential is unrecoverable
- [ ] The ownership paragraph matches ship-2's behaviour — the entrypoint repairs ./data; the chown line is documented only for containers pinned to a non-root user
- [ ] Every command in both documents was executed against a clean box by a human, and the PR says so; no untested command appears
- [ ] docs/architecture.md hosting lines are re-pointed at these documents instead of repeating them
- [ ] Explicitly out of scope and named as such: the comparison page, the PaaS templates, and the marketing site
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Hand someone the README who has never seen the repository: they get a running, HTTPS-served instance from a published tag, know what to back up, and know what happens if they lose secret.key — without asking a question.

**Spec** — CONTEXT.md — BYOK ('Losing it makes every stored key unrecoverable — docs must say this in bold'); CONTEXT.md — Hostability decisions #5 and #6; Standing debt ('Rollback is unsafe and undocumented', './data ownership landmine'); README.md (still the TanStack Start template)

#### `ship-12` · afk · S — One-click templates — Coolify, Railway, Render, Unraid

**Blocked by:** `ship-10`, `ship-8`

**What to build**

CONTEXT's Hosting rules end with 'Publish Coolify / Railway / Render / Unraid templates. Cheap, huge reach — that's where self-hosters live', and nothing owns it. Once there is a published tag and a written install doc, each template is a small declarative file wrapping the same two-container shape. The one thing that actually breaks these platforms is the database: we need pgvector, and only some managed Postgres offerings have it — Render's does, Railway needs the pgvector image variant. A template that provisions a plain Postgres fails at the first migration, so each one either provisions pgvector or says plainly that it cannot. Two other rules: APP_URL comes from the platform's assigned domain (a template that leaves it unset reproduces the Secure-cookie login loop on a platform that always terminates TLS), and ./data must be a persistent volume or every restart loses secret.key and with it every stored credential.

**Acceptance criteria**

- [ ] Templates under deploy/ for Coolify, Railway, Render and Unraid, each pinning a published tag and never `latest`
- [ ] Each provisions Postgres with pgvector, or states in its description that the platform cannot and is unsupported — no template fails at the first migration
- [ ] APP_URL is wired to the platform's assigned domain in every template, and a deployed instance sets a Secure cookie on login
- [ ] ./data is a persistent volume in every template, and each description carries the backup-and-secret.key sentence from ship-10
- [ ] Each template is deployed once by a human and the resulting URL reaches /setup with the token retrievable from that platform's log view — a template whose setup token is unreachable is a broken install and is fixed or dropped here
- [ ] The README links the templates and says which platforms were actually tested and when
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Deploy from the Railway template, wait, open the assigned URL, read the setup token out of the platform's logs, and finish the wizard — a working instance with no terminal involved.

**Spec** — CONTEXT.md — Hosting ('Publish Coolify / Railway / Render / Unraid templates. Cheap, huge reach'); CONTEXT.md — Hostability decisions #6 (frozen required-env set), Two self-host auth traps #1 and #2; docker-compose.yml (the two-container shape the templates wrap)

## 22. Drive as the archive, Box on the same port

#### `storage-16` · afk · M — Live files — follow a Sheet, keep its revisions

**Blocked by:** `storage-10b`, `storage-8a`

**What to build**

The file-grain binding: 'Link and follow' on a Sheet, a shared Excel or any file creates a storage_binding with grain 'file' and direction 'pull'. Each provider revision advances the document and appends to document_revision — the machinery from storage-10b, triggered per file rather than per folder, and sharing the same (connection, drive) cursor so following ten files does not mean ten polls. The document's preview gains a revision ledger in the append-only pattern the portfolio surfaces already use: rows on rules, a mono timestamp lane, the provider revision id, the current revision marked, and no edit affordance anywhere. One direction only — editing happens where the editor is.

**Acceptance criteria**

- [ ] following a file that is already filed attaches the binding to the existing document rather than creating a second one
- [ ] three edits in the fake produce three revisions carrying the provider's revision ids and one current sha
- [ ] following ten files on one drive adds no additional changes.list passes per poll
- [ ] the ledger exposes no edit or delete control, matching the append-only event surfaces
- [ ] unfollowing stops polling and keeps every revision
- [ ] a followed file deleted at the provider marks the pointer gone and stops the binding without deleting our revisions
- [ ] Gate 5 on the revision ledger
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Follow the seeded Sheet from a holding's Files tab, edit it twice in the fake, and the document reads rev 3 with a two-row history beneath it.

**Spec** — spec-storage-sources.md (removed) §5.2; spec-storage-sources.md (removed) §10; spec-storage-sources.md (removed) §13

_Decided 2026-10-24 (owner): build now, on the Files tab as it is on main_ — `SPA-341` shipped, so the printed `RecordFiles` is the surface. The shape, drawn on Paper (Windows · 09 Live files):

- **Follow lives in the file row's `···`**, beside Open · Download · Open in Drive ↗ · Change kind › · Remove…, with the hint `keeps revisions`; on a followed file the same item reads Unfollow. No separate "Link and follow" button.
- **The row's lane** reads `rev 4 · 10 Oct · following` for a followed file; states: `rev 5 · fetching.` while a revision arrives, `■ gone · 4 revisions kept` after a provider delete, `rev 4 · stopped 12 Oct` after unfollow.
- **The viewer sidebar's `Revisions · n` ledger replaces Versions** for a followed file: `LabelHead` with `following` on the right, rows `rev n · current` / `rev n` / `rev 1 · linked` with a mono time lane, the current row on bone; the foot carries the provider id (`Drive · 1aBcD…9xYz`) and `Unfollow`. No edit or delete control anywhere.
- Holdings have no Files tab, so Follow lives on company and deal Files tabs; the demo follows the seeded Sheet from the holding's company.
- One `(connection, drive)` cursor serves folder bindings and followed files alike; a followed file shares the poll.

#### `storage-17` · afk · M — Binding health — the binder left, the token died

**Blocked by:** `storage-14`, `storage-3b`, `storage-8b`

**What to build**

The failure surfaces §5.5 promises, which today have nowhere to appear. Settings → Connections lists each connection's bindings with status, last sync and last error; Today carries binding errors and the waiting-export count as ledger rows; a paused or errored binding can be re-bound to another user's connection for the same provider, resuming with a full re-list rather than a stale cursor — the cursor belongs to (connection, drive), so it cannot survive the move. Re-binding validates first: the new connection must hold the required scopes and must actually be able to read the folder, because the folder may simply not be shared with that user, and a re-bind that silently starts failing is worse than a refusal. Disconnecting a connection that owns bindings warns with the count, pauses them, and never deletes copied documents.

**Acceptance criteria**

- [ ] revoking the connection at the provider turns every binding on it error at the next poll with the provider message stored, and touches no document
- [ ] 'Re-bind with my connection' calls getFolder on the new connection first and refuses with the provider's message when the folder is unreadable or a scope is missing
- [ ] a successful re-bind repoints connection_id, clears the cursor, sets status active, and the next sync creates zero duplicate documents
- [ ] Today shows one row per errored binding and one row for files waiting to export, and both disappear when resolved
- [ ] disconnecting a connection with bindings shows the count and, on confirm, pauses them rather than deleting anything
- [ ] Gate 5 on the Today rows and the bindings list
- [ ] Full gate pass: tsc, vitest green, lint zero, prettier

**Demo** — Revoke the grant at the fake IdP: Today shows the binding error and Settings → Connections shows the reason; re-bind as a second user who can read the folder and the sync resumes with no duplicates, while a second user who cannot read it is refused by name.

**Spec** — spec-storage-sources.md (removed) §5.5; spec-storage-sources.md (removed) §7; spec-storage-sources.md (removed) §12

_Amended 2026-10-11 (pre-check):_ `SPA-234` is Done. D81 split Connections up: a storage account's page is `/settings/files/$connectionId` (`AccountSection job="files"`), so the bindings list goes there. Binding errors and the waiting-export count are lines in Today's notices band (`NoticesBand`), not Needs-you rows. The dedupe index `document_connection_external_unique` is keyed on `document.connection_id`, so a re-bind must repoint `connection_id` on the binding's documents in the same transaction or the next sync duplicates every file.

_Decided 2026-10-24 (owner): confirmed as amended._ The shape, drawn on Paper (Settings · 10 Binding health):

- **The account page** keeps its head (`anish@fund.example`, Disconnect) and a status line (`Google · Drive · in sync · 3 min`), then a **Bound folders · n** ledger: folder name · record · status · verb. Status is a dot plus mono text — `in sync · 3 min · 128 files`, the provider's words in destructive (`Google said: File not found · 2 days`), or `paused · Priya disconnected 9 Oct`. The verb is `Open ›` on a healthy row and `Re-bind ›` on an errored or paused one. An **Exports** ledger beneath carries `3 files waiting for a Drive connection · since 9 Oct · Fund docs` while anything waits.
- **Re-bind is a window** (S420): one picker, `With: <connection> · Drive`, limited to the caller's connections for the provider; under it the check result — `■ Can read the folder · 41 files · drive.readonly` or the refusal in the provider's words (`Google said: notFound · the folder isn't shared with tomas@fund.example · nothing changed`); foot `re-lists · no duplicates` · Cancel · Re-bind (Try again after a refusal).
- **Disconnect** on an account with bindings confirms: `n bound folders pause until someone re-binds them with their own connection. Nothing already copied is deleted.` Cancel · Disconnect.
- **Today's notices band**: one line per errored binding (`Vayu — Legal can't sync · Google said: File not found` · `Fix ›` opening the account page) and one for files waiting (`3 files waiting for a Drive connection` · `Files ›`); both leave when resolved.
- Binding row states: in sync · error (token or folder) · paused (binder left) · just re-bound (`re-listing. 41 files`).
