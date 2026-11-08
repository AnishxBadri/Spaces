# Backlog

Full bodies of the open slices, the repo copy of their Linear issues. Linear issues get archived once shipped, so this file is what keeps an open spec readable. Amend a body here and in Linear together. When a slice ships, delete its body here; the bodies of every shipped slice of projects 14–29 are in git at `1860d2c` (`git show 1860d2c:docs/roadmap-backlog.md`).

---

## 31. Edges and icons, and the AI shape

Three slices the owner agreed on 2026-11-07/08 (Linear project P-SPA-35, "31. Edges and the AI shape"). `edges-1` is the canvas's "Edges and icons" system (`docs/design-contract.md` §1 "The edges", E1–E8); `ai-a` and `ai-b` reshape what the AI lanes send. Order: `edges-1` ∥ `ai-a`, then `ai-b` (migration). Nothing here is dispatched until the owner says go.

---

#### `edges-1` (SPA-387) · afk · L — Edges and icons: the 12px edge, folder tabs, the toolbar, create buttons, one icon list

**Blocked by:** none (port-C1/C2 shipped). **Runs beside** `ai-a` (no shared files). **Does not touch** `lib/ai/*`. **Owns** the page frame: `components/page-header.tsx`, `components/ui/tabs.tsx`, `components/table/*`, `components/views/*`, every list route under `routes/_app/`, `components/deal-board.tsx`, `routes/_app/today.tsx`, `components/today/*`, `components/record/record-parts.tsx`, `components/ui/dialog.tsx`, `components/settings/*`, `components/ui/more-menu.tsx`, a new `components/icons.ts` and `components/provider-mark.tsx`, and `apps/web/src/styles.css`.

**The rule** is the contract's E1–E8; the boards are the Paper Record page `p-S-0`, boards 16–27 (Notes, Companies, record + window + menu, Today, Meetings, Tasks, Deals board, Files, Spaces, Portfolio, Settings). Mandate, Review and Import follow by rule with no board. Board 18 (the details column) is not agreed: leave the record's property grid as it is.

**What to build, in this order** (each step leaves every gate green; commit per step).

1. **The frame (E1–E4).** Page edge 12px (`px-3`), title on it; body gutter 4px; a content card is a 1px `border-rule` box, 4px between cards, 7px inset. Under every head one rule, never `double-rule`. The head stays 104px and keeps the scroll fold (`HeadBar` to 48px with tabs/toolbar pinned); the `···` is rightmost and its right edge aligns with the content's last control. Windows: one 16px inset all round (`DialogContent`, head, body, foot). Settings and form pages cap at 800px left-aligned, the head `···` moving with the cap (replaces today's centred 700px column); lists and tables full width. A settings row opens Edit as a whole; its actions always visible. Fix the Deals board's clipped last column here (it bled against `px-8`).
2. **Folder tabs and the toolbar (E5, A10).** `Tabs` renders on white with the `tab-open` outline; no bone band. The list toolbar: tabs · divider · Filter and Sort as icon buttons outlined only while in use, reading `Filter 2` / `Last contact ↓`; search right with `/`; Columns as an icon at the end of the column-head row; Save view only when there is something to save (`Save as view…` on a filtered All; `Update view` + `Reset` on a changed view; `Save as new view…` in the view's `···`). `RecordTable` boxed, column lines, white column heads.
3. **Notes list (board 16).** One card, time bands `THIS WEEK` / `EARLIER` with no count (E8), kind shown by the board-15 icons, an optional Memos tab, no `17 notes` line under the title.
4. **Create buttons (E6).** Every create is `+ New x` in pine (`Button` primary with the Lucide `Plus`). Split `[+ New x | ▾]` on Notes and Spaces only, the `▾` listing templates; the Spaces composer row goes. Files' create is `Upload`; Portfolio's primary is `Record a check`. Tasks keeps the head button and the `Add a task…` row, the button focusing the row. Window confirms carry no icon.
5. **Icons (E7).** `components/icons.ts` maps each verb to one Lucide icon (`new`, `import`, `filter`, `sort`, `columns`, `search`, `open`, `upload`, `enrich`, `archive`, `more`, …) and every call site imports from it; custom SVGs stay only for the note kinds, on Lucide's 24-grid. `ProviderMark` draws brand marks monochrome from Simple Icons (Google, Box, Airtable, Gmail, Apollo, Exa, Granola, Anthropic, OpenAI, Google Calendar, Google Drive) and replaces every inline logo.
6. **Head menus.** A head `···` only where the code has a menu; a lone frequent verb is a button, a lone rare one stays in the `···` (`forceMenu`, A7). Settings' only actions stay buttons.
7. **Contract.** `docs/design-contract.md`: `px-8` gone from §1 "Material and scale" and the precedent map's settings column line; §5's Edges entry deleted; §3 precedents re-pointed where a shape moved.

**Acceptance criteria**

- [ ] On every list, Today, a record, Settings and a window, the title and the first card's content sit on x = 12 from the page edge; cards are 1px rule boxes 4px apart (render tests on `PageHeader`, `LedgerSection` in a card, `DialogContent`).
- [ ] No `double-rule` under a page head; `px-8` appears in no route or page-level component (grep test).
- [ ] The head `···` right edge equals the content's last control's right edge on a list and on Settings (layout test with measured boxes).
- [ ] Settings pages are ≤ 800px of content, left-aligned; lists are full width.
- [ ] Folder tabs: the open tab carries `tab-open`, no bone band renders; Filter/Sort show state text only while in use; Save view controls render only when there is something to save (tests on the toolbar).
- [ ] Notes list is one card with `THIS WEEK`/`EARLIER` bands, no counts on bands, no count line under the title.
- [ ] Every create button reads `+ New x`; Notes and Spaces render the split; Files reads `Upload`; Portfolio's primary is `Record a check` (tests).
- [ ] `components/icons.ts` is the only Lucide import site for verbs (lint rule or grep test); `ProviderMark` is the only place a brand logo is drawn.
- [ ] The Deals board's last column is not clipped at 1280px.
- [ ] Gates: typecheck, test, lint, prettier; web build; one browser pass over the eleven boards.

---

#### `ai-a` (SPA-388) · afk · M — The prompt shape: system and user parts, cache markers, one shared prefix per lane

**Blocked by:** none. **Runs beside** `edges-1`. **Owns** `lib/ai/complete.ts`, `lib/ai/prompt.ts`, `lib/ai/column-run.ts`, `lib/ai/attribute-run.ts`, `lib/ask/turn.ts`, `lib/ai/providers/llm/*`, and the tests beside them. No migration; no schema change.

**Today:** `completeProgram` renders one string with `renderPrompt` (context blocks, then the task) and sends it as a single user message with no system message. Every call is a fresh prefix, so nothing caches, and a column run over 200 rows re-sends the attribute prompt 200 times.

**What to build.**

1. **Two parts.** `completeProgram` sends `system` and `messages`. The system part is the lane's instructions (the fixed text of the task: what to produce, the format, the schema's intent) and, after `ai-b`, the mandate. The user part is the shared material (the context blocks `renderPrompt` renders) and then the variable part last (the row, the question, the document). `renderPrompt`'s budget still truncates the context blocks, never the system part. The `vision` lane keeps its `file` parts after the text in the user message.
2. **Cache markers.** On Anthropic, `providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` on the system part; Ask (`lib/ask/turn.ts`) sends its history as real messages instead of a `The conversation so far:` string, with rolling markers on the last two messages so each turn re-reads the cache. Other providers get the same message shape and no marker.
3. **AI columns.** `column-run.ts` / `attribute-run.ts` put the attribute's prompt and the object's shape in the system part and the row's values last, so a run over N rows shares one prefix byte-for-byte.
4. **Usage.** Read the provider's cached-input count from the AI SDK usage (`cachedInputTokens`) and carry it on `CompleteResult.usage`; log it with the run's usage line. Storing it waits for `ai-b`'s column.
5. **Tests.** A unit test on the message builder: two calls of one lane with different variable parts produce byte-identical system parts and identical user prefixes up to the variable part; a column run over three rows shares its system part; Ask's last two messages carry the marker and the earlier ones do not; the `vision` call keeps its file parts; `renderPrompt`'s truncation still bites the context, not the task.

**Acceptance criteria**

- [ ] Every `completeProgram` call sends a system part and a user part; no lane sends one concatenated string (test).
- [ ] Byte-identical prefix across calls of a lane and across a column run's rows (tests).
- [ ] Anthropic calls carry the cache marker on the system part; Ask carries rolling markers on its last two messages (tests on the built request).
- [ ] `CompleteResult.usage.tokensCached` is set from the provider's count, `null` where the provider has none.
- [ ] Gates: typecheck, test, lint, prettier; web build. A live check on one Anthropic call shows `cache_read_input_tokens > 0` on the second call.

---

#### `ai-b` (SPA-389) · hitl · M · migration — The mandate in every judging lane, and cached tokens on the ledger

**Blocked by:** `ai-a`. **Owns** `lib/ai/complete.ts` (the system part's mandate slot), the judging lanes' callers (`column-run.ts`, `attribute-run.ts`, `read-deck-summarize.ts`, the meeting prep, `propose.ts`'s suggest-spaces), `lib/server/mandate.ts`, `packages/db/src/schema/ai.ts`, `routes/_app/settings/usage.tsx`.

**hitl:** the owner has not yet confirmed that AI column answers may change under the mandate. Ask before step 1 and record the answer in `docs/decisions.md`.

**What to build.**

1. **The mandate in judging lanes.** A `renderMandate` (pure, `packages/core`) prints the mandate's facts as a short block. `completeProgram` puts it in the system part after the lane instructions, before the cache marker, for the judging lanes only: AI columns, meeting prep, summaries (`read-deck-summarize`), suggest spaces. Mechanical lanes (extract, classify, embed, vision text) never see it. With no mandate recorded, the block is absent and the prefix is unchanged.
2. **`tokens_cached`.** Migration: `ai_usage.tokens_cached integer` nullable (and the same on `ai_run`'s step usage if it carries tokens). `completeProgram` writes `usage.tokensCached` from `ai-a`.
3. **Usage page.** `settings/usage.tsx`: the Tokens readout gains the cached share (`Cached · 41%` when any run has it); the run table's tokens cell reads `in (cached) / out`; `tokens()` handles null.

**Acceptance criteria**

- [ ] A judging lane's system part contains the mandate block when a mandate exists and not otherwise; a mechanical lane's never does (tests per lane).
- [ ] The prefix stays byte-identical across rows with the mandate in it (test).
- [ ] Migration adds `tokens_cached`; `boot.test.ts` green; `ai_usage` rows carry it after an Anthropic call.
- [ ] Usage page prints the cached share and per-run cached count (render test).
- [ ] Gates: typecheck, test, lint, prettier; web build; `boot.test.ts` alone.

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
