# Backlog

Full bodies of the open slices, the repo copy of their Linear issues. Linear issues get archived once shipped, so this file is what keeps an open spec readable. Amend a body here and in Linear together. When a slice ships, delete its body here; the bodies of every shipped slice of projects 14–29 are in git at `1860d2c` (`git show 1860d2c:docs/roadmap-backlog.md`).

---

## 31. Edges and icons, and the AI shape

Slices of Linear project P-SPA-35, "31. Edges and the AI shape". `edges-1` (SPA-387), `ai-a` (SPA-388) and `notes-1` (SPA-391) shipped 2026-11-10; `edges-2` (SPA-392), `record-1` (SPA-393) and `settings-1` (SPA-394) shipped 2026-11-11 (the owner's option D: the 24px edge, the bone ground, one ink folder; the record's unboxed rail and long text; settings in group cards); `settings-2` (SPA-395), `shell-2` (SPA-396) and `record-2` (SPA-397), the three from the owner's review of 2026-11-11, shipped 2026-11-12. One slice is left: `ai-b` carries the migration and waits on the owner.

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

## 32. One backend grammar

Slices of Linear project P-SPA-36, "32. One backend grammar". Two decisions of 2026-11-12 (owner): D84, a module in `apps/web/src/lib` that does I/O is Effect, and the 53 that are not get converted in a planned sweep; D85, Effect Schema is the one schema language and Zod leaves. `schema-1` (SPA-400) shipped 2026-11-12: `input()` in `lib/server/input.ts` is the helper, and `lib/server/tasks.ts` with `lib/tasks/create.ts` is the reference module every later slice copies. The `effect-*` slices own disjoint files and run one after another, each beside a slice from another area.

**What a conversion is, for every `effect-*` slice.** It changes the grammar and nothing a user or a caller can see.

- A function that queries, writes, fetches or enqueues becomes an Effect program (`Effect.fn('name')`), on the pattern of `lib/server/objects.ts`: failures are `Schema.TaggedError` classes, a database call goes through a `tryPromise` helper that names the failure, and a server fn runs its program through `effectFn()` or `Effect.runPromise`.
- A database failure is one `Schema.TaggedError` per area with `cause: Schema.Defect()`, shared by the area's files with its `tryPromise` helper (`ask/query.ts` is the pattern), not one class per file.
- The client receives a rejected tagged error as a plain `Error` with its `message` and nothing else: no `_tag`, no fields. So a tagged error carries the `message` the UI prints today, word for word. A handler that threw `new Error('Admins only')` rejects with an error whose `message` is `Admins only`.
- An exported async function that a file outside the slice calls (a route, a worker job through `#web/*`, another `lib/` module) keeps its name and its signature, and becomes a one-line run of the program. The program is exported beside it for callers that are already Effect. No file outside the slice's list changes, except a test that asserted on an error's class.
- A `.validator()` in a listed file moves from zod to Effect Schema through `input()`. A message written by hand (`Expected YYYY-MM-DD`) is kept word for word; zod's default wording becomes Effect's. Unknown keys are still dropped. A validator runs on the server only, so a test of one goes through TanStack's `execValidator`, as `input.test.ts` does. A zod shape imported from a file outside the list stays zod and is named in the report.
- A listed file that turns out to do no I/O (it builds SQL and runs none, or holds types, or the grep matched a comment) stays plain and is named in the report with the reason.
- Transactions keep their boundaries; nothing that ran inside one runs outside it afterwards, and the reverse.
- Existing tests pass with their assertions unchanged. A conversion that needs a test's expectation changed is a behaviour change: stop and name it.

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

**Does not touch** `lib/server/shared.ts` or `lib/portfolio/**`.

**Spec.** D84, and the conversion rules at the head of this section. The portfolio void flow (`lib/portfolio/reverse.ts`) is already Effect and its tagged errors carry an empty `message` on purpose: `ledgerVoidMessage` is what the dialog shows. Leave that as it is.

**What to build.** The seven modules, by the rules. Handlers yield the session gate's Effect twin from `effect-1`.

**Acceptance criteria**

- [ ] Each listed file imports `effect`, and no listed file imports `zod`, or the report names the file and why.
- [ ] After this slice no non-test file in `lib/server/` imports `db` without importing `effect` (a grep in the report).
- [ ] No file outside the list changed, bar tests that asserted on an error class.
- [ ] Gates: typecheck, lint, the `@spaces/web` tests, prettier on touched files, the web build and `scripts/check-client-bundle.sh`.

---

#### `effect-3` (SPA-405) · afk · L — Documents, notes, views, records and the portfolio loader become Effect

**Blocked by:** `effect-2`. **Owns**, in `apps/web/src/lib/`: `documents/` (`blob-refs.ts`, `fetch-guard.ts`, `preview-card.ts`, `record-files.ts`, `unfiled.ts`, `upload.ts`), `notes/` (`from-suggestion.ts`, `list-rows.ts`, `ordering.ts`, `templates.ts`), `views/` (`paging.ts`, `resolve.ts`, `scope.ts`, `sql.ts`), `records/` (`head.ts`, `pictures.ts`), `portfolio/` (`detail.ts`, `holding.ts`), and their tests. 2,300 lines.

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
