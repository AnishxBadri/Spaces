# Backlog

Full bodies of the open slices, the repo copy of their Linear issues. Linear issues get archived once shipped, so this file is what keeps an open spec readable. Amend a body here and in Linear together. When a slice ships, delete its body here; the bodies of every shipped slice of projects 14–29 are in git at `1860d2c` (`git show 1860d2c:docs/roadmap-backlog.md`).

---

## 30. The canvas lands — follow-ups

Project 30 (Linear P-SPA-34) shipped all 25 slices on 2026-10-30; their bodies are in git at `1bf42228` (`git show 1bf42228:docs/backlog.md`). The browser passes that closed each wave found the small faults below. They are in the slices' close comments. Nothing here needs a decision or a migration, and the rules in `docs/design-contract.md` apply as written. The two slices run side by side on the files each one owns.

---

#### `port-C1` (SPA-385) · afk · M — Follow-ups: Today, lists, dates and the holding

**Blocked by:** none. Runs beside `port-C2`. **Owns:** `components/today/needs-you.tsx`, the day lanes listed in item 2, `components/inbox/suggestion-card.tsx`, `lib/ai/recorded-note-tasks.ts`, `components/attributes/value-editor.tsx`, `components/ui/more-menu.tsx`, `routes/_app/deals.tsx`, `components/deal-board.tsx` (except `MoveStageDialog`, which `port-C2` may import), `lib/portfolio/detail.ts`, `packages/core/src/portfolio/ownership.ts` and `routes/_app/portfolio_.$holdingId.tsx`.

**What to build.**

1. **Today rows truncate their text while the row has room.**
   - **Cause:** in `needs-you.tsx`, every row renders the fixed `LANE.action` (120px) and `LANE.who` (120px) spans even when they are empty, so about 430px of blank lanes outlive the text. The title and the context also shrink at the same rate, so the title is cut first.
   - **Fix:** render an empty lane as nothing, and let the context shrink before the title (`shrink-[999]` on the context).
2. **The 72px day lane wraps an older date.**
   - **Cause:** `4 Oct 2024` does not fit 72px in mono, and the lane has no `whitespace-nowrap`. The lane is repeated inline in `record-timeline.tsx` (History), `record/record-notes.tsx`, `thread-row.tsx`, `record-overview.tsx` and `space-overview.tsx` (twice).
   - **Fix:** one shared `Day` lane component, `w-22` and `whitespace-nowrap`, used by all six sites.
3. **A Review suggestion printed `Oct 25, 2026`.** No app code formats that; it is model text.
   - The prompt in `recorded-note-tasks.ts` fixes the format of `due` only. Add a line asking for dates in prose as `4 Oct 2024`.
   - `TaskBody` in `suggestion-card.tsx` prints `due` as raw `YYYY-MM-DD`; pass it through `formatDay`.
4. **Empty cells show two dash styles.**
   - **Cause:** every empty cell prints `—`, but the date, number, currency and rating cells set it in the mono `numeric` face, where an em dash reads as a hyphen.
   - **Fix:** one `EmptyDash` in sans `text-graphite`, whatever the cell's face.
5. **Deals:**
   - **Close date sits off its head.** `attributeColumnMeta` marks a date column numeric, so the head right-aligns, while the cell's button carries both `text-left` and `numeric`. Drop `text-left` from the cell variant so cell and head align.
   - **`Import…` is a head button.** `MoreMenu` turns a one-item menu into an outline button, and Deals passes only the import verb. Give `MoreMenu` a `forceMenu` prop for list heads, so Deals' head is `···` alone.
   - **The board's last column is clipped.** The `overflow-x-auto` scroller sits inside the page's `px-8` and ends flush with the last column. Bleed the scroller to the page edge (`-mx-8 px-8`) with an end spacer, so the last column scrolls fully into view.
6. **The holding's as-of date filters nothing below the readouts.**
   - **Cause:** `detail.ts` hands `asOf` to `holdingMetrics` and `ownership` only. The investment, mark, distribution and round lists are loaded unfiltered.
   - **Fix:** filter each event list to `date <= asOf` before the sections render.
   - **Keep the reversal reader contract:** originals stamped with `reversedAt`, dropped by `@spaces/core/portfolio/reversal` once the as-of day reaches that instant.
   - If this grows past a filter, ship items 1–5 and split this one out.
7. **The Ownership rail reads `Cost basis only` for the wrong reason.**
   - **Cause:** the fallback in `ownership.ts` also catches priced checks whose rounds lack `sharesOutstanding`, and a mix of instruments, while the tooltip always says "unconverted instrument".
   - **Fix:** carry the reason out of `ownership()` and print it: `Shares outstanding unknown`, `Unconverted instrument` or `Mixed instruments`.

**Acceptance criteria**

- [ ] A Needs-you row with no action and no person gives its text the freed width (render test).
- [ ] `4 Oct 2024` fits one line in every day lane (one shared component, a render test).
- [ ] A suggestion's `due` prints through `formatDay` (test).
- [ ] Empty date, number and text cells render the same dash (test).
- [ ] The Deals head is `···` only; Close date aligns with its head; the board's last column scrolls fully into view.
- [ ] An as-of date before an event hides that event's rows (loader test, with a reversed event on each side of the date).
- [ ] The Ownership rail names why it fell back (unit test on each reason).
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-C2` (SPA-386) · afk · M — Follow-ups: windows, Cmd-K, notices and Connections

**Blocked by:** none. Runs beside `port-C1`. **Owns:** `components/log-interaction-dialog.tsx`, `components/create-deal-dialog.tsx`, `components/palette-preview.tsx`, `components/command-palette.tsx`, `components/meeting-dialog.tsx`, `routes/_app/ask.tsx`, `components/email-dialog.tsx`, `components/attributes/ai-config-section.tsx`, `components/record/record-notices.tsx`, `lib/connections/providers.ts`, `lib/connections/provider-view.ts` and `components/settings/provider-setup.tsx`. Imports `MoveStageDialog` from `deal-board.tsx` without editing that file.

**What to build.**

1. **Log interaction's `When` is a native US-format datetime, clipped at 176px.** The app has no date-time field; the nearest pattern is `DateCellEditor` in `value-editor.tsx`, which prints `formatDay` text until clicked and then opens the native control. Do the same here, printing `13 Oct, 10:42`, and widen the lane so it never clips. Don't edit `value-editor.tsx` (`port-C1` owns it); copy the pattern.
2. **`Create deal` is enabled with no company.** Disable it until a company is picked (`disabled={pending || !companyId}`). The submit-time check stays.
3. **Cmd-K:**
   - **The record pane prints a `0` readout.** `filledReadouts` drops only `—` and `''`, but `moving30` and `daysInStage` can be `0`. Treat a zero as absent.
   - **A passage row shows its file name in quotes.** The row wraps its text in “ ” even when there is no snippet and the text is the file name. Quote only a snippet.
   - **`Move stage…` to Passed or Lost skips the close reason.** `moveStageStep` writes the stage at once, while the record page goes through `MoveStageDialog`, which asks for a reason on `passed` and `lost`. For those two stages, hand off to `MoveStageDialog`; other stages still move at once.
4. **The meeting window prints an empty `PARTICIPANTS` head.** Render the group only when there are participants. With none, `Open in Google ›` moves to the window's `···`.
5. **Absence sentences** (contract: an empty section renders nothing):
   - `No threads.` in `ask.tsx`;
   - `No body.` in `email-dialog.tsx`;
   - `No attribute answers with AI.` in `ai-config-section.tsx`, where the band's count already reads `0 set`.
6. **Record notice fix links are pine.** `fixClass` in `record-notices.tsx` is `text-primary`; Today's notices use `text-foreground`. Make it `text-foreground`. This also inks `Restore ›`, `Compare ›` and `Enrichment ›`.
7. **Connections:**
   - **The list and the Set up tab disagree.** `testing` reads true when any held Google token carries `refreshTokenExpiresAt`, while Set up preselects `Google Workspace` and `Internal` when nothing is saved. Read `testing` from the saved `audience` only. Show both Segmented controls with no selection until an admin saves a choice.
   - **Step 6 keeps its hint after it works.** `TestRow` shows `Once a use is on in In use` whenever no use is on, even beside `■ Works · <email>`. Hide the hint once the test has worked.

**Acceptance criteria**

- [ ] `When` prints `formatDay` text and never clips; `Create deal` is disabled without a company (tests).
- [ ] The Cmd-K pane never prints a `0` readout; a snippet-less passage shows the bare file name; `Move stage…` to Passed or Lost asks for the reason (tests).
- [ ] No participants means no `PARTICIPANTS` head; the three absence sentences are gone (tests).
- [ ] Record notice fix links are ink.
- [ ] Unsaved provider choices show no selection, and the list says `Testing` only when the saved audience is personal; the step-6 hint goes once it works (tests).
- [ ] Gates: typecheck, test, lint, prettier; web build.

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
