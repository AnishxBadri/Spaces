# Backlog

Full bodies of the open slices, the repo copy of their Linear issues. Linear issues get archived once shipped, so this file is what keeps an open spec readable. Amend a body here and in Linear together. When a slice ships, delete its body here; the bodies of every shipped slice of projects 14–29 are in git at `1860d2c` (`git show 1860d2c:docs/roadmap-backlog.md`).

---

## 31. Edges and icons, and the AI shape

Slices of Linear project P-SPA-35, "31. Edges and the AI shape". `edges-1` (SPA-387), `ai-a` (SPA-388) and `notes-1` (SPA-391) shipped 2026-11-10; `edges-2` (SPA-392), `record-1` (SPA-393) and `settings-1` (SPA-394) shipped 2026-11-11 (the owner's option D: the 24px edge, the bone ground, one ink folder; the record's unboxed rail and long text; settings in group cards); `settings-2` (SPA-395) shipped 2026-11-12. Three slices are left. `ai-b` carries the migration and waits on the owner. `shell-2` and `record-2` come from the owner's review of 2026-11-11; they own disjoint files and can run side by side.

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

## 32. One backend grammar

Slices of Linear project P-SPA-36, "32. One backend grammar". Two decisions of 2026-11-12 (owner): D84, a module in `apps/web/src/lib` that does I/O is Effect, and the 53 that are not get converted in a planned sweep; D85, Effect Schema is the one schema language and Zod leaves. `schema-1` goes first and alone among these: it proves the server-fn boundary and ships the helper every later slice uses. The `effect-*` slices own disjoint files and run one after another, each beside a slice from another area.

**What a conversion is, for every `effect-*` slice.** It changes the grammar and nothing a user or a caller can see.

- A function that queries, writes, fetches or enqueues becomes an Effect program (`Effect.fn('name')`), on the pattern of `lib/server/objects.ts`: failures are `Schema.TaggedError` classes, a database call goes through a `tryPromise` helper that names the failure, and a server fn runs its program through `effectFn()` or `Effect.runPromise`.
- A tagged error carries the `message` the UI prints today, word for word. A handler that threw `new Error('Admins only')` rejects with an error whose `message` is `Admins only`.
- An exported async function that a file outside the slice calls (a route, a worker job through `#web/*`, another `lib/` module) keeps its name and its signature, and becomes a one-line run of the program. The program is exported beside it for callers that are already Effect. No file outside the slice's list changes, except a test that asserted on an error's class.
- A `.validator()` in a listed file moves from zod to Effect Schema through the `schema-1` helper. A zod shape imported from a file outside the list stays zod and is named in the report.
- A listed file that turns out to do no I/O (it builds SQL and runs none, or holds types, or the grep matched a comment) stays plain and is named in the report with the reason.
- Transactions keep their boundaries; nothing that ran inside one runs outside it afterwards, and the reverse.
- Existing tests pass with their assertions unchanged. A conversion that needs a test's expectation changed is a behaviour change: stop and name it.

---

#### `schema-1` (SPA-400) · afk · M — The server-fn boundary on Effect Schema: the helper, the proof, and Tasks as the reference module

**Blocked by:** nothing. **Owns** a new `lib/server/input.ts` (the helper), `lib/server/tasks.ts`, `lib/tasks/create.ts`, their tests, and the Backend paradigm lines of `CLAUDE.md`.

**Does not touch** `components/app-sidebar.tsx`, `lib/email/compose.ts` or the compose windows (`shell-2` runs beside this slice), or any other server module.

**Spec.** D85. Checked by hand on 2026-11-12: effect `4.0.0-rc.112` has `Schema.toStandardSchemaV1(schema)`, and `@tanstack/start-client-core` 1.170.14's `execValidator` looks for `'~standard'` before `.parse`, with `StandardSchemaValidator` in router-core's `Validator` union. A plain Effect schema carries no `~standard`, so each `.validator()` needs the wrap. Not yet checked: a real `createServerFn` under `pnpm typecheck`. That is step 1, and the rest of project 32 waits on it.

**What to build.**

1. **The proof, first.** One `createServerFn` whose `.validator()` takes a wrapped Effect schema: the handler's `data` infers the decoded type with no assertion, a valid call returns, an invalid call rejects. **If `data` does not infer, or the wrap cannot be made to typecheck without an assertion, stop there and report: the decision goes back to the owner.**
2. **The helper.** `input(schema)` in `lib/server/input.ts`: one export, the wrap and nothing else, safe to import from a client-imported server-fn module (it imports `effect` only). Its JSDoc says what a caller gets.
3. **What a refused input looks like.** Today a zod failure reaches the client as a message. Find what the client receives from a Standard Schema failure, make the message a reader can act on (the field and what was expected), and state both shapes in the report. A test pins the new one.
4. **Tasks, whole.** `lib/server/tasks.ts` and `lib/tasks/create.ts` are converted as the reference module for both decisions: every validator through `input()`, every handler an Effect program run through `effectFn()`, by the conversion rules at the head of this section. `isoDate` and the other shapes keep their constraints and their messages.
5. **The bundle.** `scripts/check-client-bundle.sh` passes. The report gives the client entry's gzipped size before and after, since Effect Schema now runs in the browser for these validators.
6. **Docs.** `CLAUDE.md` Backend paradigm: two lines, a new validator is an Effect schema through `input()`, and no new file imports `zod`.

**Acceptance criteria**

- [ ] A type-level test proves `data` in a handler is the schema's decoded type.
- [ ] `input()` has tests for a valid input, an invalid one, a transformed one (a trimmed string, a defaulted field).
- [ ] `lib/server/tasks.ts` and `lib/tasks/create.ts` import no `zod` and are Effect; every existing Tasks test passes with its assertions unchanged.
- [ ] The refused-input message is pinned by a test and described in the report beside the old one.
- [ ] Bundle check passes; the size delta is in the report.
- [ ] Gates: typecheck, lint, the affected tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

---

#### `effect-1` (SPA-401) · afk · L — The record server modules and the session gate become Effect

**Blocked by:** `schema-1`. **Owns** `lib/server/shared.ts`, `attributes.ts`, `companies.ts`, `deals.ts`, `people.ts`, `glossary.ts`, `mandate.ts`, `members.ts` and `inbox.ts` in `lib/server/` (2,100 lines, 53 server fns), and their tests.

**Does not touch** the other files in `lib/server/` (`effect-2`), or `components/record/**`, `lib/records/overview.ts` and the four record routes (`record-2` runs beside this slice).

**Spec.** D84, and the conversion rules at the head of this section. Size L because `shared.ts` is one file every server module imports, and splitting it across slices would have two agents in it.

**What to build.**

1. **The session gate is typed.** `requireUser` and `requireAdmin` reject with tagged errors, `Unauthorized` and `Forbidden`, whose messages stay `Unauthorized` and `Admins only`. Their async signatures stay: 341 call sites keep working untouched. Each gains an Effect twin for programs to yield.
2. **`shared.ts`.** Its helpers that do I/O become programs with async wrappers, by the rules. `birthHolding`'s re-export stays.
3. **The eight server modules.** By the rules.

**Acceptance criteria**

- [ ] Each listed file imports `effect`, and no listed file imports `zod`, or the report names the file and why.
- [ ] `requireUser` rejects with `Unauthorized` and `requireAdmin` with `Forbidden` (tests on the class and on the message); every existing `rejects.toThrow('Unauthorized')` and `'Admins only'` test passes unchanged.
- [ ] No file outside the list changed, bar tests that asserted on an error class (listed in the report).
- [ ] Gates: typecheck, lint, the `@spaces/web` and `@spaces/worker` tests (the worker crosses into `shared.ts`), prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

---

#### `effect-2` (SPA-403) · afk · L — The rest of the server modules become Effect

**Blocked by:** `effect-1`. **Owns** `documents.ts`, `emails.ts`, `notes.ts`, `portfolio.ts`, `settings.ts`, `setup.ts` and `templates.ts` in `lib/server/` (1,950 lines, 77 server fns), and their tests.

**Does not touch** `lib/server/shared.ts`, `packages/core/src/portfolio/**`, `lib/portfolio/**` or the holding route (`ownership-1` runs beside this slice).

**Spec.** D84, and the conversion rules at the head of this section. The portfolio void flow (`lib/portfolio/reverse.ts`) is already Effect and its tagged errors carry an empty `message` on purpose: `ledgerVoidMessage` is what the dialog shows. Leave that as it is.

**What to build.** The seven modules, by the rules. Handlers yield the session gate's Effect twin from `effect-1`.

**Acceptance criteria**

- [ ] Each listed file imports `effect`, and no listed file imports `zod`, or the report names the file and why.
- [ ] After this slice no non-test file in `lib/server/` imports `db` without importing `effect` (a grep in the report).
- [ ] No file outside the list changed, bar tests that asserted on an error class.
- [ ] Gates: typecheck, lint, the `@spaces/web` tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

---

#### `effect-3` (SPA-405) · afk · L — Documents, notes, views, records and the portfolio loader become Effect

**Blocked by:** `effect-2`, `ownership-1`. **Owns**, in `apps/web/src/lib/`: `documents/` (`blob-refs.ts`, `fetch-guard.ts`, `preview-card.ts`, `record-files.ts`, `unfiled.ts`, `upload.ts`), `notes/` (`from-suggestion.ts`, `list-rows.ts`, `ordering.ts`, `templates.ts`), `views/` (`paging.ts`, `resolve.ts`, `scope.ts`, `sql.ts`), `records/` (`head.ts`, `pictures.ts`), `portfolio/` (`detail.ts`, `holding.ts`), and their tests. 2,300 lines.

**Does not touch** `packages/sdk/**`, `plugins/**`, `packages/core/**` or `lib/integrations/**` (`schema-2` runs beside this slice).

**Spec.** D84, and the conversion rules at the head of this section. Three cautions:

- `views/sql.ts` and `views/resolve.ts` compile SQL. The expression `compileSortKey` emits must stay byte-identical, because the `attr_idx_*` indexes match on it; `value-index-plan.test.ts` is the EXPLAIN assertion. A file that only builds SQL stays plain.
- `portfolio/detail.ts` hands the pure libs originals only, each stamped with `reversedAt`. That reader contract does not move.
- `documents/fetch-guard.ts` is the SSRF guard. Its checks keep their order, and a refused fetch still never opens a socket.

**What to build.** The listed files, by the rules.

**Acceptance criteria**

- [ ] Each listed file imports `effect`, or the report names it as pure with the reason.
- [ ] `value-index-plan.test.ts`, the fetch-guard tests and the portfolio as-of tests pass unchanged.
- [ ] No file outside the list changed, bar tests that asserted on an error class.
- [ ] Gates: typecheck, lint, the `@spaces/web` and `@spaces/worker` tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

---

#### `effect-4` (SPA-406) · afk · M — The last I/O modules become Effect, and a lint rule keeps it so

**Blocked by:** `effect-3`. **Owns**, in `apps/web/src/lib/`: `ai/enqueue-embed.ts`, `ai/enqueue-restamp.ts`, `ai/lanes.ts`, `arrival/synced-settings.ts`, `ask/types.ts`, `auth.ts`, `email/fixtures.ts`, `inbox/context.ts`, `integrations/runnable.ts`, `interactions/email-draft-prefill.ts`, `meetings/day.ts`, `members/suspend.ts`, `queue.ts`, `search/waves.ts`, `spaces/filed-in.ts`, `spaces/live.ts`, `spaces/tag.ts`, and their tests (1,300 lines); a new rule in `packages/config/eslint-rules/` and its line in `eslint.base.js`; the Principles and Backend paradigm sections of `CLAUDE.md`.

**Does not touch** `packages/core/src/attributes/**`, `packages/core/src/writes/attributes/**` or `lib/rpc/**` (`schema-3` runs beside this slice).

**Spec.** D84, and the conversion rules at the head of this section. Several of these were listed by a grep and may hold no I/O (`ask/types.ts`, `ai/lanes.ts`, `email/fixtures.ts`); `auth.ts` is better-auth's configuration, not a program. Each stays plain if so, with the reason in the report.

**What to build.**

1. **The listed files,** by the rules.
2. **The enforcer.** An eslint rule, `effect/io-is-effect`: a non-test file under `apps/web/src/lib/` that imports the `db` value (from `@spaces/db` or `#/db`) must import from `effect`. Type-only imports do not count. A file that is exempt for a stated reason carries an `eslint-disable` with that reason on the import; expect a handful and list them. The rule has its own tests, on the pattern of the rules beside it, and `turbo.json`'s lint inputs already cover the directory.
3. **Docs.** `CLAUDE.md` Principles gains the principle and its enforcer ("I/O is an Effect program; a pure helper, a type module and client code stay plain"); the Backend paradigm section's "existing modules convert only when already open" sentence is replaced by the rule.

**Acceptance criteria**

- [ ] `pnpm lint` is green with the rule on, and red when a `lib/` file imports `db` without `effect` (the rule's own test).
- [ ] The report lists every exempted file and its reason.
- [ ] No file outside the list changed, bar tests that asserted on an error class.
- [ ] Gates: typecheck, lint over every package (the rule lives in `packages/config`), the `@spaces/web` and `@spaces/worker` tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

---

#### `schema-2` (SPA-402) · afk · L — The plugin contract on Effect Schema: SDK 2.0, every plugin, no zod

**Blocked by:** `schema-1`. **Owns** `packages/sdk/**`, `plugins/**`, the host's manifest readers and resolve hook (`packages/core/src/plugins/**`, `apps/worker/src/plugins/**`), and the `lib/integrations/**` files that read a manifest through the SDK.

**Does not touch** the files `effect-3` lists (it runs beside this slice), or `packages/core/src/attributes/registry.ts` beyond the import of the enrichment vocabulary.

**Spec.** D85. The registry is empty and no plugin release key is published, so no plugin outside this repo exists: the contract is cheapest to change now, before the first public release. Size L because the contract and its nine plugins move together or not at all.

**What to build.**

1. **The contract.** `manifest.ts` (`manifestSchema`, the `settings` and job `settings` an author writes, `settingsJsonSchema`), `vocabulary.ts`, `ports.ts` (the AI port's `schema`, `configOf`, `watchSettingsOf`) and `pack/` read and write Effect Schema. `zod` leaves the SDK's dependencies and `src/package.test.ts`'s pinned list.
2. **The emitted manifest does not change shape.** `manifest.json` still carries the settings as JSON Schema. For the echo fixture and for apollo, the emitted `manifest.json` before and after differs only in its `sdk` range, or the report names each other difference and why it is harmless to the settings form.
3. **Every plugin and fixture.** The nine plugins under `plugins/` and the fixtures under `plugins/_fixtures/` author their settings and AI schemas in Effect Schema. `zod` leaves their peers. Each `manifest.sdk` range becomes `^2`.
4. **The host.** `host-resolve.ts` stops handing a bundle `zod`. The loader refuses a 1.x bundle as it refuses any range it does not satisfy, and a refused plugin reads as degraded, as now.
5. **The version.** `SDK_VERSION` and the package are `2.0.0`, with a major changeset that says what an author changes. The pending 1.5 changesets fold into it.
6. **The bundled plugins.** `pnpm bundle-plugins` re-run, so first boot installs 2.0 builds.
7. **Docs.** `docs/spec-plugin-sdk.md` and the SDK's README: every zod example becomes Effect Schema.

**Acceptance criteria**

- [ ] No file under `packages/sdk/src` or `plugins/` imports `zod`, and no `package.json` there names it.
- [ ] The manifest comparison of step 2 is in the report.
- [ ] The loader's tests cover a 1.x bundle refused and a 2.0 bundle loaded.
- [ ] Every plugin's own suite passes.
- [ ] The report says which plugins a running install must reinstall (those not bundled).
- [ ] Gates: the full `turbo run build`, typecheck, lint and test over every package, prettier on touched files.

---

#### `schema-3` (SPA-404) · afk · M — `valueValidator` on Effect Schema: one type system for attribute values, inside and at `/api/v1`

**Blocked by:** `schema-2`. **Owns** `packages/core/src/attributes/registry.ts`, `attributes/default-values.ts`, `writes/attributes/values.ts`, `import/coerce.ts`, `enrichment/plan.ts`, `ai/schema.ts`, the `lib/rpc/**` handlers that decode a record's values, and their tests.

**Does not touch** the files `effect-4` lists (it runs beside this slice).

**Spec.** D85, and Backend paradigm decision 3 in `CONTEXT.md`, which asked for this lift when `/api/v1` was built: HttpApi speaks Effect Schema, the attribute engine spoke zod, and the seam between them is where an external write is checked. `valueValidator` is the attribute engine's type system, so the lift happens once and here.

**What to build.**

1. **`valueValidator` returns an Effect schema** for an attribute, with every constraint it has today (type, options, required, uniqueness is not its job) and the same messages.
2. **The one write path decodes with it.** `setValues` and its helpers in `writes/attributes/values.ts`; the import coercer; the enrichment plan; the AI column's answer schema.
3. **`/api/v1` uses it directly.** The handlers that take record values compose the same schema into their HttpApi payloads; any zod-to-Schema bridge at that seam goes.
4. **What stays zod in core** is named in the report with a count per folder.

**Acceptance criteria**

- [ ] Every existing attribute, import, enrichment and API test passes with its assertions unchanged, messages included.
- [ ] One test per attribute type feeds the same bad value through `setValues` and through `/api/v1` and gets the same refusal.
- [ ] The listed files import no `zod`.
- [ ] Gates: typecheck, lint, the `@spaces/core`, `@spaces/web` and `@spaces/worker` tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

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

#### `ownership-1` (SPA-399) · afk · S — Ownership counts the shares sold

**Blocked by:** nothing. **Owns** `packages/core/src/portfolio/ownership.ts` and its tests, the two call sites in `lib/portfolio/detail.ts`, the one in `lib/records/readouts.ts`, and the ownership figure's fixtures in `lib/seeds/dev.ts` if a seeded holding's number moves.

**Does not touch** `lib/server/**` (`effect-2` runs beside this slice). No migration.

**Spec.** `ownership()` sums the shares bought and never subtracts `distribution.shares_sold`, so after a secondary or a partial exit the percentage is overstated (found 2026-11-12). The correction policy is unchanged: the loader passes originals only, each stamped with `reversedAt`, and a voided sale stops counting once the as-of day reaches the void (`liveAt`).

**What to build.**

1. **Sales in.** `ownership()` takes the holding's sales (date, shares sold, `reversedAt`), filtered by as-of and `liveAt` as the checks are. At each counted round, our shares are those bought on or before it less those sold on or before it.
2. **A sale after the last counted round still shows.** The history gains a point at the sale's date over the last known fully-diluted count, so `currentPct` is honest. Its `roundKind` is `sale`; the timeline prints it as a sale, not as a round.
3. **Sold out reads zero.** A round before the first purchase is still skipped; a point after the last share is sold reads 0%, and is not skipped.
4. **Implied and cost-basis-only are untouched.** A SAFE has no shares to sell.
5. **Callers.** The holding loader, the as-of loader and the record readout pass the sales. If MCP's `standingAt` computes ownership on its own, name it in the report.

**Acceptance criteria**

- [ ] Tests: a partial sale between two rounds, a sale after the last round, a full exit, a voided sale before and after the void's instant under `asOf`, and a holding with no sales (unchanged output).
- [ ] The dev seed's two holdings with `sharesSold` show the reduced percentage on the holding page (stated in the report with before and after).
- [ ] Gates: typecheck, lint, the `@spaces/core` and `@spaces/web` tests, prettier on touched files.

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
