# Backlog

Full bodies of the open slices, the repo copy of their Linear issues. Linear issues get archived once shipped, so this file is what keeps an open spec readable. Amend a body here and in Linear together. When a slice ships, delete its body here; the bodies of every shipped slice of projects 14–29 are in git at `1860d2c` (`git show 1860d2c:docs/roadmap-backlog.md`).

---

## 31. Edges and icons, and the AI shape

Slices of Linear project P-SPA-35, "31. Edges and the AI shape". `edges-1` (SPA-387), `ai-a` (SPA-388) and `notes-1` (SPA-391) shipped 2026-11-10; `edges-2` (SPA-392), `record-1` (SPA-393) and `settings-1` (SPA-394) shipped 2026-11-11 (the owner's option D: the 24px edge, the bone ground, one ink folder; the record's unboxed rail and long text; settings in group cards). Four slices are left. `ai-b` carries the migration and waits on the owner. `settings-2`, `shell-2` and `record-2` come from the owner's review of 2026-11-11; they own disjoint files and can run side by side.

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

#### `settings-2` (SPA-395) · afk · M — Settings read plainly: noun heads, no empty cards, no head that repeats the title

**Blocked by:** nothing. **Owns** `components/settings/**`, `routes/_app/settings/**`, `components/integrations/plugin-template.tsx`; may touch `components/attributes/registry-list.tsx` for rule 4 only.

**Does not touch** `components/app-sidebar.tsx` (`shell-2`) or `components/record/**` (`record-2`), which may run beside this slice. In `docs/design-contract.md` and `DESIGN.md` it edits the settings sections only.

**Spec.** The owner read the settings pages `settings-1` built and asked for them to be plainer (2026-11-11). Six rules came out of that review, all agreed. Two of them reverse `settings-1` (a state and an action side by side in a row's end lane; a column-head row on every table card): this slice is the later word. Nothing here was drawn on Paper; the rules below are the drawing.

**What to build.**

1. **A group head is a noun.** One or two words, never a clause. The renames:

   | Now                    | Becomes                                  | Where                                   |
   | ---------------------- | ---------------------------------------- | --------------------------------------- |
   | `What it switches on`  | `Used by`                                | `plugin-template.tsx`                   |
   | `What it sends`        | `Data sent`                              | `plugin-template.tsx`                   |
   | `What's set up`        | `Setup`                                  | `routes/_app/settings/general.tsx`      |
   | `Who does what`        | `Routing`                                | `routes/_app/settings/models.tsx`       |
   | `What fills what`      | `Fields`                                 | `enrichment-section.tsx`                |
   | `Sources, in order`    | `Sources`                                | `enrichment-section.tsx`                |
   | `Calls outside a run`  | `Other calls`                            | `routes/_app/settings/usage.tsx`        |
   | `Members may use`      | `Access`                                 | `provider-page.tsx`                     |
   | `Enrich automatically` | `Auto-enrich`                            | `enrichment-section.tsx`                |
   | `Waiting to join`      | `Invites`                                | `routes/_app/settings/members.tsx`      |
   | `Disable or uninstall` | no card: both acts join the head's `···` | `plugin-template.tsx`, the plugin route |

   The plugin page's `···` gains `Disable` (or `Enable`) and `Uninstall…`; Uninstall keeps its confirm. Any other group head that reads as a clause is named in the report, not renamed.

2. **An empty card does not draw.** A card with nothing to show and nothing to act on is left out, as an empty section already is on a record. Named cases: on a plugin page `Workspace key` (when the plugin asks for none), `Data sent`, `Used by`, `Recent runs`, and `Settings` while the manifest is unread (the `Status` card already says so); Enrichment's `Recent runs`. A card stays when it holds a control to add the first thing (Objects' `Yours`), and a page never ends up blank: when its only card is empty, that card keeps its empty line.

3. **One group, no head.** A page that draws a single group draws it with no head (`SettingsGroup` without `title`, named by `label`). The page title already says it: Templates, Currency & FX, Email forwarding, Connections, Files, Meeting notes, Search when it shows one group, Members when there are no invites. The count is already in the nav; a head action moves to the page head. Members with invites keeps both heads, `People` and `Invites`.

4. **A column head only when it tells columns apart.** `SettingsColumns` draws only on a card with three or more named columns. Members (`Person`, `Role`) and any other two-column card lose it. Where it stays (Providers, Routing, Runs, rates, tokens, accounts, Fields), it must read as a head, not as another row: the default is the list table's head cell, 32px, `text-label` graphite, with the column rule between cells that `RecordTable`'s `th` has. This is the one part not agreed by sight, so the report carries a screenshot of Models with it.

5. **General · Identity is one row.** A 64px logo tile and the Name field beside it. The tile is the upload control: a click or a drop opens the file picker, and hover and focus name the act (`Upload`, or `Replace` when a logo is held). `Remove` is a quiet text link in the row's end lane, drawn only when a logo is held. The logo still writes at once with a toast; the name still joins the Save bar.

6. **General · Setup rows say one thing.** The end lane holds one item: a tick when the piece is set up, `Set up ›` when it is not. The words `set`, `not set` and `Open` go. The whole row opens its page. Rows not set up come first; each run keeps its present order. The head keeps its count (`3 of 7`). At 7 of 7 the card does not draw.

7. **Docs.** `docs/design-contract.md` § 3 "A settings section" states rules 1 to 4; `DESIGN.md` "Settings" likewise. `docs/decisions.md` D80 and D81 each gain a dated amendment line (2026-11-11, owner): the renamed heads, Setup hiding when complete, Disable and Uninstall in the plugin page's menu.

**Acceptance criteria**

- [ ] No group head in settings is one of the eleven old titles; a test lists the settings group titles and fails on a clause (`What`, `Who`, a comma).
- [ ] A degraded plugin with no manifest draws its `Status` card and no empty card; `Disable` and `Uninstall…` are in the head's `···` (render test).
- [ ] Templates, Currency & FX, Email forwarding, Connections, Files and Meeting notes draw one headless card; Members draws no group head without invites and two with (render tests).
- [ ] Members draws no column-head row; Models' Providers and Routing do.
- [ ] General's Identity is one row with a 64px tile that opens the file picker; `Remove` appears only with a logo.
- [ ] A Setup row holds a tick or `Set up ›`, never both, and never `set`, `not set` or `Open`; unfinished rows lead; the card is absent at 7 of 7 (render tests).
- [ ] A member still sees every page read-only (existing tests keep passing).
- [ ] Browser pass on General, Members, Models, a plugin page and Enrichment; the report carries the Models screenshot for rule 4.
- [ ] Gates: typecheck, lint, the affected tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

---

#### `shell-2` (SPA-396) · afk · S — One account menu at the sidebar foot, and Drafts under Library while there are some

**Blocked by:** nothing. **Owns** `components/app-sidebar.tsx` and its tests (`app-sidebar.test.tsx`, `nav-grammar.test.ts` where it reads the foot), and the drafts count's invalidation in `lib/email/compose.ts` and the compose windows that save, send or trash a draft.

**Does not touch** `components/settings/**` (`settings-2`) or `components/record/**` (`record-2`). In `docs/design-contract.md` and `DESIGN.md` it edits the shell sections only.

**Spec.** The sidebar foot holds two targets in one row with nothing between them: the account row (a menu of `Drafts`, `Keyboard`, `Sign out`) and a gear (Settings). The owner found it confusing and asked what Drafts is for (2026-11-11). Agreed: one row, one menu, and Drafts moves to where a reader would look for it. This reverses "Settings is the account row's one icon" from the shell sheet (2026-10-08). There is still no email page: mail is read on the record it concerns, and Drafts is the one list of mail not yet sent.

**What to build.**

1. **One foot row.** Expanded, the account row is one trigger across the full width: the initials square and the name. The email line goes (it never changes; the menu's first line already prints it). The gear goes. The row keeps its height, so the Ask row above does not move.
2. **One menu.** `Signed in as <email>`, a rule, `Settings` with `G ,` in its key lane, `Keyboard` with `?`, a rule, `Sign out`. It opens to the right of the chassis as now. `Drafts` leaves it.
3. **Collapsed.** The Settings icon goes; the initials square opens the same menu. The Ask icon stays.
4. **The key stays.** `G ,` still opens Settings from anywhere.
5. **Drafts under Library.** A `Drafts` row after `Files`, drawn only while the reader has at least one draft. Its right lane holds the count, as Tasks' holds `13 due`. It is a button, not a link: it opens the drafts window (`openDrafts`) and never reads as the current page. Its icon comes from the icon list; add one there only if none fits. Collapsed, it is an icon whose tip reads `Drafts · n`. The mobile drawer draws it too.
6. **The count is live.** The sidebar reads `countEmailDrafts` on mount under `EMAIL_DRAFTS_QUERY` (it is read only when the menu opens today). Saving a draft, sending one and trashing one each invalidate that key, so the row appears with the first draft and leaves with the last, with no reload.
7. **Unchanged.** The workspace head's menu (`General`, `Members`, `Invite a member…`), the Ask row, the settings chassis.
8. **Docs.** `DESIGN.md` (the sidebar foot, the keyboard sheet's "the account menu lists it"), `docs/product-map.md` (the Sidebar A row), `docs/design-contract.md` (the shell line on the account row), and a dated amendment line (2026-11-11, owner) on the shell decision in `docs/decisions.md`.

**Acceptance criteria**

- [ ] The expanded foot has one focusable control, the account trigger; no link to `/settings` sits beside it, and no email line is drawn (render test).
- [ ] The menu lists `Settings`, `Keyboard`, `Sign out` in that order, and no `Drafts`; `Settings` navigates to `/settings`.
- [ ] Collapsed, the foot is the Ask icon and the account trigger; no Settings icon.
- [ ] `G ,` still opens Settings (existing test keeps passing).
- [ ] With no drafts the Library group has no `Drafts` row; with two it has one reading `2`, after `Files`, and activating it calls `openDrafts` (render tests).
- [ ] Saving, sending and trashing a draft each invalidate `EMAIL_DRAFTS_QUERY` (test per path).
- [ ] Browser pass: both sidebar states, the menu open, a draft saved from a compose window and the row appearing.
- [ ] Gates: typecheck, lint, the affected tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

---

#### `record-2` (SPA-397) · afk · S — A lone readout joins the rail: the Overview strip needs two

**Blocked by:** nothing. **Owns** `components/record/record-overview.tsx`, `lib/records/overview.ts`, `RailRow` in `components/record/record-parts.tsx`, and the readout wiring in the four record routes (`companies_.$companyId.tsx`, `people_.$personId.tsx`, `deals_.$dealId.tsx`, `o_.$objectSlug.$recordId.tsx`).

**Does not touch** `components/settings/**` (`settings-2`), `components/app-sidebar.tsx` (`shell-2`), `components/space-overview.tsx` or Today. In `docs/design-contract.md` it edits § 3's record sections only.

**Spec.** A record's Overview draws a 76px strip of readouts, built for four. A readout with no value is already left out, so a company with one interaction and nothing else shows a strip holding one date and 600px of nothing. The owner asked about it (2026-11-11). Agreed: a strip needs two readouts; one alone is a row in the rail. The strip itself stays: on a company that is held it carries Ownership and Moving, the numbers the record is opened for.

**What to build.**

1. **Two or more, a strip.** The Overview draws the readout strip only when two or more readouts have a value. Its layout does not change.
2. **One, a rail row.** A single readout is drawn in the record's rail as a `RailRow`: its label on the rail's 104px label lane, its value in mono, on the same rules as the attribute rows. It sits after the last attribute row and before the `N empty` row. It is read only: no editor, no hover control, no pointer. A `bad` tone keeps its crimson.
3. **None, nothing.** As now.
4. **One decision, one place.** A pure `splitReadouts` in `lib/records/overview.ts` takes the readouts and returns the strip's and the rail's: none and none, none and one, or two-plus and none. The four record routes read it once and hand each half to its place, so the strip and the rail can never both draw the same readout.
5. **`RailRow` on the lane.** If `RailRow` predates the 104px label lane, bring it onto it: the label and the value start where an attribute row's do.
6. **Docs.** `docs/design-contract.md` § 3, the Overview and the Rail: the strip's rule of two and the lone readout's row.

**Acceptance criteria**

- [ ] `splitReadouts` is tested at 0, 1, 2 and 4 shown readouts, and with empty values mixed in (a `—`, a 0, a null).
- [ ] A record with one readout draws no `[data-overview-readouts]` and one read-only rail row carrying its label and value; with two it draws the strip and no such rail row (render tests).
- [ ] The rail row's label and value share their left edges with an attribute row's (test on the shared classes or a measured pass).
- [ ] All four record kinds follow it: company, person, deal, custom object.
- [ ] Browser pass on a company with one readout and one with several.
- [ ] Gates: typecheck, lint, the affected tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

---

## Corrections

Slices of Linear project P-SPA-28, "Corrections".

---

#### `notes-kind` (SPA-398) · afk · S · migration — Two note kinds: `scratch` leaves the enum and every surface

**Blocked by:** nothing. **Owns** the `note_kind` enum (`packages/db/src/schema/kinds.ts`, one hand-written migration and its journal entry), `lib/notes/kind.ts`, the kind validators in `lib/server/notes.ts`, `components/note-kind-icon.tsx`, `components/notes/note-menu.tsx`, `components/notes/note-head.tsx`, the kind type in `components/record/record-notes.tsx`, and the scratch rows in `lib/seeds/dev.ts`.

**Does not touch** `components/settings/**` or `routes/_app/settings/**` (`settings-2` runs beside this slice). The docs are already amended (D83 in `docs/decisions.md`, the note model in `CONTEXT.md`, the note head in `docs/design-contract.md`); edit none of them.

**Spec.** D83 (owner, 2026-11-12): a note has two kinds, Note and Memo. `scratch` pinned nothing, faced nothing and had no tab, so it was a choice on every note for nothing. Every `scratch` note becomes a `note`; a template whose `note_kind` is `scratch` maps the same way.

**What to build.**

1. **The migration, hand-written.** On the pattern of `packages/db/drizzle/0037_drop_document_kind_memo.sql`: rename `note_kind` to `note_kind_old`; create `note_kind` as `('note','memo')`; `DROP DEFAULT` on `note.kind`; alter **both** columns, `note.kind` and `template.note_kind` (nullable), with `USING (CASE WHEN col::text = 'scratch' THEN 'note' ELSE col::text END)::note_kind`; `SET DEFAULT 'note'` on `note.kind`; drop the old type. Drizzle's generated SQL has no mapping and aborts on a scratch row, so run `db:generate` only to get the snapshot and replace its SQL, or write the file and the journal entry by hand. The journal `when` is the clock at write time (`date -u +%s000`), greater than 0091's. Print it in the report. No index or constraint depends on the type (checked 2026-11-12); confirm before the rename.
2. **The schema.** `noteKind` in `kinds.ts` reads `['note', 'memo']`. The drizzle snapshot matches, so the next `db:generate` proposes nothing.
3. **The code.** `NOTE_KINDS` in `lib/notes/kind.ts`, both kind validators in `lib/server/notes.ts`, the kind icon, the note menu and the head's kind toggle lose `scratch`. The toggle and the menu read `Note · Memo`; the stamp reads `NOTE` or `MEMO`. Any copy that explains scratch goes with it (the note list's line that a scratch note is listed like any other).
4. **The seed.** `lib/seeds/dev.ts` seeds its two scratch notes as `note`.
5. **Everything else that names the kind.** `grep -ri scratch apps packages` and settle each hit: a note kind goes, an unrelated scratch directory or scratch pad stays. Name the hits left in the report.

**Acceptance criteria**

- [ ] A database holding a `scratch` note and a template with `note_kind = 'scratch'` migrates: both read `note` afterwards, and `note_kind` has two labels (migration test, or `boot.test.ts` extended on the pattern of 0037's).
- [ ] `boot.test.ts` is green, and `pnpm db:generate` after the migration reports no changes.
- [ ] No server fn accepts `scratch` as a kind (test on the validator).
- [ ] The note menu and the head toggle offer two kinds (render tests updated).
- [ ] No test names `scratch` as a note kind.
- [ ] Gates: typecheck, lint, the affected tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

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
