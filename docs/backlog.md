# Backlog

Full bodies of the open slices, the repo copy of their Linear issues. Linear issues get archived once shipped, so this file is what keeps an open spec readable. Amend a body here and in Linear together. When a slice ships, delete its body here; the bodies of every shipped slice of projects 14–29 are in git at `1860d2c` (`git show 1860d2c:docs/roadmap-backlog.md`).

---

## 31. Edges and icons, and the AI shape

Slices of Linear project P-SPA-35, "31. Edges and the AI shape". `edges-1` (SPA-387), `ai-a` (SPA-388) and `notes-1` (SPA-391) shipped 2026-11-10. On 2026-11-11 the owner replaced the edges of `edges-1` with the ones drawn as option D on the Paper page "Edges options" (the 24px edge, the bone ground, one ink folder), agreed how a record prints its attributes, and asked for the settings port: `edges-2`, then `record-1` beside `settings-1`. `ai-b` is still open and carries the migration.

---

#### `edges-2` (SPA-392) · afk · L — The 24px edge, the bone ground and the one ink folder

**Owns** `components/page-header.tsx` (`PAGE_EDGE`, `PageBody`, `Card`), `styles.css` (`--inset`, the `card` utility, the folder), `components/ui/tabs.tsx`, `components/head-fold.tsx`, `components/table/record-table.tsx` (the table box) and the list toolbar, `routes/_app/today.tsx`, the record chassis in `components/record/record-parts.tsx` (`RecordBody` and the rail container only), every list and board route's frame, `docs/design-contract.md` § 1 "The edges" and the primitives table, the `DESIGN.md` sentences they contradict.

**Does not touch** `components/settings/**` and `routes/_app/settings/**` (`settings-1`), `components/attributes/**`, `property-fold.tsx`, `PropertyGrid`, `PropertyCell` and `RailField` (`record-1`). Settings may look out of step until `settings-1`; leave it rendering as it does today as far as the shared primitives allow.

**Spec.** `docs/design-contract.md` § 1 "The edges", E1–E11, is the rule. The drawings are in the Paper file `spaces`, page "Edges options": the boards "Today · D ranked cards", "Record · D ranked cards" and "Companies · D ranked cards", the right frame of each (bone ground). Where a page is not drawn, apply the rule.

**What to build.**

1. **The numbers.** The content edge is 24px, the body gutter 12px, the card inset 11px: `PAGE_EDGE`, `PageBody` (padding and gap), the root `--inset` (24px) and the `card` utility's `--inset` (11px). Everything that spells the old 12 / 4 / 7 by hand moves with them: page and record heads, the folded `HeadBar` and its pinned actions, tab bars, toolbars, notices, save and selection bars, the table box wrapper. Grep for them; this list is not complete. `NOTE_INSET` does not change.
2. **The ground.** Under its head a page's body is bone and fills the height of the view; the head, and the folded head, stay paper with one rule under. Every card is paper. A tab row or toolbar pinned under the folded head carries bone, so nothing scrolls through the gutter.
3. **A card's own head is paper.** 44px with a sentence-case title at the title step for a section card (Today's Meetings), 28px with a mono caps label for a small card (Today's Portfolio and What's moving), a rule under either. Bone stays only for a band inside a card or a folder (`Band`, a `SectionHead` inside the folder body). Today's right rail becomes two paper cards on the ground: no bone rail, no ink edge.
4. **The folder, the one ink object on a page.** The `Tabs` bar sits on the ground: no background, a hairline along its foot, flush with the gutter so the open tab's left edge is the body's left edge. The open tab is paper with a hairline top, left and right and covers that line. The body under it is paper with a hairline left, right and bottom and no top. One primitive draws it. It is used by every list page (tabs and toolbar over the table box, whose frame becomes hairline while the column lines stay rule), the Notes list, the record's tabbed pane, the space page's tabs, and Today's Needs you: its bone head and `Segmented` become folder tabs, `Needs you n · Tasks n · Review n · Deals n · Marks n`, the first tab the unfiltered ledger, with the same counts and filtering as now. A page with no tabs has no hairline card. Where a page has two tab bars, the page's own is the folder and the inner one is a plain tab bar inside a rule card.
5. **The record chassis.** The body is the ground with the 12px gutter: the rail on the left sits straight on the bone, with no card and no border, its content on the 24px edge; the folder is on its right. What is inside the rail is `record-1`'s. The stacked layout below `xl` keeps working.
6. **Every other page, by the rule.** Deals (board and table), Portfolio, a holding, Tasks, Files, Meetings, Spaces, a space, Mandate, Review, Import, the note page: the 24px edge, the 12px gutter, paper cards on bone, a folder where there are tabs. The board's columns and cards keep their own materials; only the frame and the edges move. Fix what bleeds or doubles.
7. **The fold.** Scrolled, the head folds to its 48px bar as now, and the folder's tabs pin under it.
8. **The contract reads the built edges.** § 1 "The edges" gains the file and utility names; the § 2 primitives table (`PageBody`, `Card`, `Tabs`, the folder) and the § 3 precedents that still say 12px, 4px or a bone rail are corrected; `DESIGN.md` likewise. Tests that pin the old class strings or measurements move with the code.

**Acceptance criteria**

- [ ] The page title and the first text of every card sit on the 24px line on Today, Companies, a company record, Notes, Deals and Portfolio (a measured-box or class-level test, in the pattern the edges tests already use).
- [ ] The body ground is bone, the head paper and every card paper on every app page outside settings.
- [ ] A tabbed page has exactly one hairline-framed folder whose open tab joins its body; a page with no tabs has none; no rule card wears a hairline.
- [ ] Today's Needs you is a folder whose tabs filter and count as the `Segmented` did (test).
- [ ] The record rail has no box and sits on the ground; the tabbed pane is the folder.
- [ ] No raw colour and no unnamed size; `instrument/vocabulary` passes.
- [ ] Gates: typecheck, lint, the affected tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.
- [ ] The report lists every route touched and anything left undone.

---

#### `record-1` (SPA-393) · afk · L — The record's details: an unboxed rail, long text as paragraphs, a relationship once

**Blocked by:** `edges-2`. **Owns** `components/record/record-parts.tsx` (`PropertyGrid`, `PropertyCell`, the rail sections), `components/record/property-fold.tsx`, `record-overview.tsx`, `relation-section.tsx`, `record-more-menu.tsx`, `components/attributes/rail-field.tsx`, `value-editor.tsx`, `attribute-dialog.tsx`, the four record routes (`companies_.$companyId`, `people_.$personId`, `deals_.$dealId`, `o_.$objectSlug.$recordId`), `packages/core/src/attributes/registry.ts` and the attribute options schema.

**Does not touch** `components/settings/**`, `routes/_app/settings/**` (`settings-1`, running beside this slice).

**Spec.** The owner agreed six points on 2026-11-11 after a survey of every attribute type; they are steps 1–7 below. The drawing is Paper board "18 Company record · details column" (page Record), which this slice makes the rule for every record kind.

**What to build.**

1. **The rail's rows, unboxed.** No grid box and no bone label cell. Each attribute is a row on a rule: a 104px label lane (sans 12 graphite, wraps, never truncates), the value after it, 32px at least. The editor opens in place as now and the row may grow; nothing shifts sideways. The rejected-write pane, where-from, the AI cell and the edit-attribute pencil keep working.
2. **A value is never clipped silently.** Sans text wraps. A mono value (domain, email, phone, url) that does not fit beside its label takes the full width, label on its own line and one value per line; one too long even then is cut in the middle with the whole value in its `title`, and a tap shows it on touch. Domain, email and phone lose their bordered chip at rest.
3. **A url reads as a link.** At rest it prints host and path without the scheme or `www.`, and an `↗` at the row's end opens it in a new tab (`rel="noreferrer"`). Clicking the value still edits it.
4. **Long text.** A text attribute can be marked long: `options.longText` (a jsonb option, so no column changes). The attribute window shows a `Long text` switch for the Text type. A long text attribute never renders in the rail; it renders in Overview as a paragraph above the readouts: its label (sans 12 graphite), the text at the body step, clamped to three lines with `More` / `Less`. Clicking it opens a textarea in place at full width that commits on blur and reverts on Esc, with no Save button; a rejected write holds crimson as a rail cell does. Several stack in registry order. An empty one is offered in the rail's `n empty +` fold, and picking it opens its paragraph editor in Overview. The system seeds company `description`, person `description` and deal `close_reason` are long text. Existing installs get the option the way `enrichmentKey` reached existing system attributes: find that precedent and follow it; if it is a hand-written data migration, write one with a real `when`, run `boot.test.ts` alone, and say so in the report. In a list table a long text cell stays one truncated line.
5. **A relationship shows once.** A `record_reference` attribute that has a rail section (Team, Associated deals, Companies, Deals, Company, People, and `RelationSections` for the rest) is not also a rail row. Check all four routes: an attribute with no section stays a row.
6. **What the head already says leaves the rail.** Person `first_name` and `last_name`: the name is the title, and renaming moves to the head's menu as `Rename…` (reuse the existing rename path if there is one, otherwise a small window with the two fields). Deal `stage`: the badge, the stepper and Move stage carry it. Deal value and close date stay as the editable copy.
7. **Order is the registry's.** The rail prints attributes in registry order and nothing reorders them. A new attribute takes `max(sort_order) + 10`, so no two collide. `SYSTEM_ATTRIBUTES` is reordered so identity and contact lead: company `domains`, `linkedin`, `funding_stage`, `business_model`, `location`, `founded_year`, then the rest; person `emails`, `phone`, `linkedin`, `twitter`, `job_title`, `location`, then the rest; deal `value`, `close_date`, `owner`, `source`, then the rest. Existing installs keep the order they have.
8. **The empty fold stays** as it is.
9. **Docs.** The contract's § 3 "A record" (Rail, View) and the board 18 sentence in § 1 read as built; `DESIGN.md` "Record Pages" likewise.

**Acceptance criteria**

- [ ] No attribute value on a company, person, deal or custom-object record is cut without its full text in a `title` (render tests for a long text, a long domain, a long url).
- [ ] A long text attribute renders as an Overview paragraph and not in the rail; editing commits on blur and reverts on Esc (test); the switch appears only for Text.
- [ ] Each relationship renders once per record (test per route).
- [ ] A person record has no First name or Last name row and can still be renamed; a deal record has no Stage row.
- [ ] Two attributes created in a row get different `sort_order` (test); a fresh seed puts identity first.
- [ ] The label lane is 104px, wraps, and there is no bone label column or grid box.
- [ ] Gates: typecheck, lint, the affected tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`; `boot.test.ts` alone if a migration was written.

---

#### `settings-1` (SPA-394) · afk · L — Settings on the shared head, in group cards

**Blocked by:** `edges-2`. **Owns** `components/settings/**` and `routes/_app/settings/**`; may restyle `components/attributes/registry-list.tsx` and nothing else under `components/attributes/`.

**Does not touch** the record routes, `components/record/**`, `rail-field.tsx`, `value-editor.tsx`, `attribute-dialog.tsx` (`record-1`, running beside this slice).

**Spec.** Settings was drawn on Paper board "27 Settings · edges" (page Record) and never ported: the app still draws its own head and unboxed rows. This slice ports it on the edges of `edges-2`. The drawing with the new numbers is "Settings · D ranked cards" on the page "Edges options", right frame, with one change the owner agreed: a group's label sits on paper inside its card, not on a bone band. The sheets S1–S16 on the Paper page "Settings" give each page's content.

**What to build.**

1. **The shared head.** `SettingsSection` draws `PageHeader`: 104px, the serif title on the 24px edge, one rule across the full width, the section's one action on the right, moving with the 800px cap (E4). The `Settings · Group` eyebrow goes: the nav beside it already says where the reader is. The member's read-only line (`Only admins can change this · ask …`) becomes the head's mono description. Entering settings no longer moves the title or the rule.
2. **Group cards on the ground.** The body is bone. Its content is a column of paper cards, 800px wide from the 12px gutter, 12px apart. `SettingsGroupHead` becomes the card's head: a 28px paper row with the mono caps label, an optional mono count beside it and an optional action on the right, a rule under. Rows sit inside on the 11px inset, 48px on rules, the last without one. Rows with no group share one card with no head. No card is hairline: a settings page has no folder.
3. **The row.** The label keeps its 210px lane and the control its left-aligned lane after it. A row's state and its action sit in the end lane at the right edge: General's `What's set up` rows read `set  Open ›` on the right, as Models' buttons already do. A row with an Edit opens it from anywhere on the row; its actions are always visible.
4. **Tables in settings** (Members, Providers, Who does what, rates, tokens, templates, objects): a card whose first row is the column heads (sans 12 graphite) on a rule, then rows on rules, the end lane for the row's actions.
5. **The Save bar** sits on the 24px edge under the same 800px cap, paper with a hairline over it.
6. **The sheets.** Each settings page is checked against its sheet (S1–S16 and S7b, S13b, S14b); the differences listed under "Sheet differences" below are built. A head `···` appears only where the page has a menu; a menu of one item is a visible button.
7. **Docs.** The contract's § 3 "A settings section" and E4 read as built; `DESIGN.md` "Settings" likewise.

**Sheet differences.** From a survey of the 19 sheets against the app. Anything not listed matches, or the app is newer and stays (the nav takeover, the member `Admin` lane, Remove logo, the Search provider hint, the per-plugin Runs view, the plugin head `···`, the Mailbox state word, the tooltip notes, the separate `What it sends` group, every hint's wording).

Three rules settle the cross-page questions; apply them on every settings page, drawn or not:

- **Row actions.** One that goes to another page is a mono text link with `›` (`Open ›`, `Set up ›`, `Configure ›`). One that acts in place or opens a window is a small button (`Add key`, `Update`, `Reset`, `Test`, `Edit`). Connections, Plugins (`integration-ledger.tsx`) and Enrichment follow it; no row mixes the two for the same kind of act.
- **A menu of one.** A row `···` holding a single item becomes that item as a visible small button in the end lane: `Revoke…` on API tokens and on Members' invites.
- **Lead marks.** A ledger row leads with an icon or mark only where it tells rows apart. Built: the recorder's product mark (Meeting notes), mail against link on invite rows (Members), the kind icon on template rows, archived ones included (Templates), the job icon on `Who does what` and `ProviderMark` on provider rows (Models), the product mark on a connection's use rows. Not built: an icon that is the same on every row (the key on tokens, the sparkle on AI answers).

Per page:

- **Email & calendar, Files** (`accounts-section.tsx`): the accounts card gains its column-head row, `Account · Used for · Status`.
- **Meeting notes** (`meeting-notes-section.tsx`): a status dot before `Synced 09:12`, as the accounts' sync lane has; the key row's label is `Add Granola`.
- **General**: a status dot before `set` / `not set` in `What's set up`.
- **Usage & limits**: the Runs count moves from the head's action slot to the count slot.
- **Connections** (`connections-list.tsx`): a status dot before each status line.
- **A connection** (`provider-page.tsx`, `provider-setup.tsx`): a `‹ Connections` back link above the title and the provider mark beside it; setup steps read as a short label (`Cloud project`, `APIs`), a sentence, and the outbound act as a small button (`Open Google Cloud`); the `Members may use` band carries its count (`2 of 3 on`); the column reads `Health · 7 days`; each use row is a switch, not a checkbox.
- **A plugin** (`plugins_.$integrationId.tsx`, `plugin-template.tsx`): a `‹ Plugins` back link above the title and the plugin's mark beside it; the usage row reads `Usage today`.
- **Enrichment** (`enrichment-section.tsx`): the group is `Enrich automatically` and its row is labelled `When a record`.

**Acceptance criteria**

- [ ] Every settings page draws `PageHeader`; the title and the rule sit where they do on Companies (test on the shared head, no eyebrow).
- [ ] Every group is a paper card on bone, 800px wide, its label on paper; no settings page draws a hairline card or a bone band as a card head.
- [ ] General's set-up rows carry their state and action in the end lane.
- [ ] A member sees the read-only line and every control disabled, as now (existing tests keep passing).
- [ ] The Save bar lines up with the cards.
- [ ] Each sheet difference is built or named in the report with the reason.
- [ ] Gates: typecheck, lint, the affected tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

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
