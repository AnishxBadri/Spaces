# Backlog

Full bodies of the open slices, the repo copy of their Linear issues. Linear issues get archived once shipped, so this file is what keeps an open spec readable. Amend a body here and in Linear together. When a slice ships, delete its body here; the bodies of every shipped slice of projects 14–29 are in git at `1860d2c` (`git show 1860d2c:docs/roadmap-backlog.md`).

The Clean UI leftovers (`SPA-355`, `SPA-356`) have their bodies in Linear only; `SPA-349`…`SPA-353` were cancelled 2026-10-25 for project 30.

---

## 30. The canvas lands — the instrument port

**Draft for owner review. Not in Linear yet.** Linear project P-SPA-34. Every body below came from reading the Paper boards (file `spaces`, pages Grammar, Kit, Foundations, Shell, Today, Lists, Record, Windows, Ask and Settings) and the code on 2026-10-25. Each body stands alone: implementers never open Paper. Board names are cited only so a reviewer can look.

**Order.** `port-0` (contract) → shared pieces `port-1`…`port-4`, **one at a time**, because they touch nearly every route → surfaces, two at a time, on disjoint files → behaviour slices, labelled apart, which don't block the look slices except where a body says so.

**Rules every body inherits** (from `port-0`, once it lands in `docs/design-contract.md`):

- **Dates:** today `10:42` (`Today` in a readout), this year `13 Oct`, older `4 Oct 2024`, never `MM-DD`, never `Intl`. Ages (`12d`) only in stat columns under 30 days.
- **Casing:** CAPS mono only for kinds, stamps and band/group labels. Everything else is sentence case, and nothing starts lowercase. A mono state word in an end lane is data, not a label.
- **Grammar:** A1–A10 and H1–H3 (contract §1).
- **No key printed in a button.** Keys go in the tooltip.
- **Twinkle, never a spinner.**

**Defaults taken where a board was silent or two boards disagreed.** The owner overrides any of these by saying so before upload:

- **D1** Overview always opens; per-kind tab memory goes. Empty tabs show in graphite with no count on records and on spaces alike.
- **D2** On the holding, the head verbs stay and the section composers go (A3).
- **D3** Deals: a `Table | Board` Segmented in the bar (as drawn), not a view tab. TerminalSplit and `drag to move` are cut.
- **D4** The list row `···` is `Open in a new tab · Add to space… · Enrich… · Copy link`, then `Archive` once `port-B4` lands. There is no Delete.
- **D5** Table date columns use the day format. Stat columns (Last contact, Last email, Last filed) print an age under 30 days and the day beyond. Readouts drop the `· Nd` tail.
- **D6** The undo hold is 5s, and toast `Undo` is sans and underlined.
- **D7** On create, an identity match is refused in the UI with a link to the existing record. The server's attach-on-match stays as the race net (D75).
- **D8** A plugin action in `···` has no credit lane until the SDK carries a cost hint.
- **D9** `Drafts n` stays in the account menu, since it is the only way into drafts.
- **D10** The Cmd-K pane is blank bone when nothing previewable is highlighted.
- **D11** The Ask route line keeps `Provider · model`, not the drawn `Cloud model`.
- **D12** The file viewer is 1152 wide in every case. There is no 896 variant.
- **D13** Save as note stays put and swaps its label to `Saved as note`. It does not navigate.
- **D14** The sidebar keeps lucide icons. The custom glyphs on the Shell board are drawing shorthand.
- **D15** Settings heads get one outline 32px action. The boards' filled 26px buttons are stale.
- **D16** Today's column-run group keeps `Accept all N` beside `Open in Review ›`.
- **D17** The `Unfiled files` readout stays a link to `/files?filed=unfiled`. It does not filter Needs you.
- **D18** The space Glossary leaves the rail and becomes `Glossary…` in the space `···`.

**Out of this project.** These need their own decision first:

- Feeds built in (contradicts D33/D77; `docs/considerations.md`).
- The note page re-layout (Record board 13).
- Drag a view tab into the sidebar.
- A CLI reset link for a sole admin who is locked out.
- List Export.
- The credit lane on plugin actions.

---

#### `port-0` · afk · S — The canvas rules into the contract and the decisions

**Blocked by:** none. Blocks every other `port-*`.

**What to build.** This slice is docs only and writes no code. It records what the canvas decided, so every later body can point at a contract section.

1. **`docs/design-contract.md` §1:**
   - **A10:** "Paper tabs with a count on every tab" → "Bone-bar tabs in sentence case, a count on every tab that holds something, none at 0; a nested switch is a bounded Segmented; a second axis is a chip in the bar."
   - **Add the H1–H3 rules:**
     - H1: an empty section is one `Name +` row, with no sentence, no composer and no 0. The absence sentence survives only where absence is news.
     - H2: you are never listed among a row's people; a sent row reads `To X`.
     - H3: a list prints the day; the time lives in the viewer or a tooltip; long lists break by week on bone bands. Today's rows and scheduled meetings show the time.
   - **Casing tiers:** CAPS mono only for kinds, stamps and band/group labels. Tabs, column heads, lane heads, property and field labels and readout labels are sans 12 graphite, sentence case. Nothing starts lowercase. A mono state word in an end lane is data.
   - **A new "Dates" subsection:** the four forms, hand-rolled, never `Intl`; ages only in stat columns under 30 days.
   - **Separation rule:** a SectionHead's count sits at the band's right in ink, or a Segmented carries the counts, never both. Add the 28px `Band`.
   - **Commentary rule:** the empty-section paragraph becomes H1.
   - **Heights:** Band 28, Segmented 28, row `···` 24. The readout strip (56–64) stays for Today and the holding's figures only.
   - **Hierarchy ladders.**
     - Text: value ink 13–14, label graphite sans 12, kind graphite mono caps, nothing lighter than graphite.
     - Surface: paper is work, bone is frame, bone-deep is pressed.
     - Line: the double rule once, ink is structure, a rule inside a pane, space inside a group.
   - **Dither rule:** dither never moves at rest. The one animated dither is the Twinkle, used only for working states. Popovers are dithered; windows are solid.
2. **`docs/design-contract.md` §2:**
   - `Tabs`: one 44px bone bar, sentence-case sans tabs, mono counts hidden at 0, the open tab paper with a straight ink edge.
   - Add `Segmented` (28px, bone-deep box, selected segment paper, counts inside).
   - `Stamp`: a plain ink rectangle, 22px, the kind only; outlined with the day when archived.
   - `RecordHeader`: the stamp alone above the title, no readout strip.
   - `PageHeader`: no `KeyHint`; a count only when there is no tab bar.
   - Add `Band`, `EmptyRow`, `FoldRow`, `MoreMenu` and `Twinkle`.
   - Window sizes: S 440 · M 560 · L 768 · viewer 1152. A second window steps down under its parent, at most one stacked.
3. **`docs/design-contract.md` §3:** rewrite the "A record" precedent to the Record board: the Overview default and the rail of attributes and relations.
4. **`DESIGN.md`:** amend the lines that say tabs stay CAPS, column heads and field labels are lowercase mono, the `Label` atom is 11px lowercase mono, "cut shoulders", "Filter rows under a tab stay the underline grammar", and `MM-DD HH:MM` in the Ledger.
5. **`docs/decisions.md`, an amendment paragraph under each:**
   - **D63/D64:** plugin verbs live in the record `···`, grouped under the plugin name in mono caps and absent when the plugin is unhealthy. The outcome is a toast, not a head figure. Host Enrich stays a head verb.
   - **D70:**
     - Cmd-K is one fixed size, `min(1060px, 100vw−2rem)` × `min(560px, 100dvh−4rem)`, and every state renders in the same box.
     - The preview pane is always mounted.
     - Ask scope chips sit in the composer, not in a head.
     - Ask moves to the sidebar foot (⌘J).
   - **D73:**
     - The space head is `···` only, and the stamp prints no depth.
     - Overview is the default tab and holds the readouts, What's moving, open tasks and latest companies.
     - The rail is Criteria, Watching and Map. Glossary goes to `···` (D18).
     - Sensitive moves to `···`.
   - **D74:**
     - Overview is the first tab and the default (D1).
     - Empty tabs show in graphite with no count.
     - Interactions' kind filter is a bounded Segmented with no composer.
     - Notes loses its filter row.
   - **D79:**
     - The head is the title plus `Thu 15 Oct · W42`, with no verbs.
     - The day strip shows only with a connected calendar and follows the Meetings day.
     - The order is Notices, Needs you, Meetings.
     - The readout strip shows non-zero figures only, and each figure filters Needs you.
     - Single proposals are decided in place; watch, column-run and Ask-thread groups fold with `Open in Review ›`.
     - Duplicates appear on Today.
     - The filter is a Segmented and the title carries no count.
     - Undo works by holding the write for 5s.
   - **D81:**
     - The nav group heads are ruled ink bands.
     - Integrations = Connections · Plugins · Enrichment · Email forwarding.
     - The workspace head opens General · Members · Invite.
     - Members gains `Send a reset link…`.
6. **`docs/product-map.md`:** move "The rules in force" and "Canvas verdicts" into a pointer to the contract and decisions, leaving only the canvas mechanics.

**Acceptance criteria**

- [ ] Every rule listed above appears in the contract or the decisions, in their voice, with no issue ids in the contract text.
- [ ] The review checklist gains questions for H1–H3, the dates rule and casing.
- [ ] `pnpm exec prettier --check` passes on the touched docs.

---

#### `port-1` · afk · L — Tabs, Segmented, bands, the empty row and casing (shared pieces 1)

**Blocked by:** `port-0`, `SPA-355` (dead-code B touches the same files).

**What to build.** These are the primitives every surface reuses. Change the primitives only; the surfaces adopt them in their own slices. Don't convert surface filter rows here.

1. **`components/ui/tabs.tsx`:**
   - Label: `label-caps` → sans `text-ui` 13/20, no transform.
   - Count: mono `text-micro` in ink. **Render no count when `count` is 0 or undefined.** An empty tab's label is graphite, and turns ink on hover.
   - One size: bar 44px (`h-11`, `pt-1 px-3`), tab 39px, open tab 40px (paper, 1px hairline top and sides, `top-px`). Delete the `size` prop; the existing `tab-open` straight edge stays.
   - Focus is the reticle; disabled is opacity .5.
   - Update the docblock and `tabs.test.tsx`, which asserts the graphite 0.
2. **`components/ui/segmented.tsx`:**
   - Box: 28px, `p-[2px]`, gap 2, bone-deep fill, 1px rule border, radius 2.
   - Segment: `px-[10px]`, gap 6, label sans `text-label`, optional `count` in mono `text-micro`, hidden at 0.
   - Selected: paper, 1px rule border, ink. Unselected: graphite; hover turns it bone-deep with ink text. Focus is the reticle round the box.
   - Delete the `size` and `hint` props. The `1`/`2` hints in `log-interaction-dialog.tsx` move to a tooltip.
   - Fold the hand-rolled radiogroups into it: `settings/embeddings-section.tsx`, `objects/object-dialog.tsx`, `attributes/value-editor.tsx`, `views/view-bar.tsx`, `settings/models.tsx`.
3. **`components/ledger-section.tsx`:**
   - `SectionHead`: 44px bone, `px-3`, 1px hairline top and 1px rule bottom, title sans `text-title` (weight 500, as the contract says), and **the count at the far right in mono micro ink**. Add a `switch` slot that takes a Segmented, which the type makes exclusive with `count`.
   - New `Band`: 28px bone, `px-3`, rule bottom, label mono caps `text-micro` `tracking-label` graphite, optional right link sans `text-label` graphite (`All interactions ›`).
   - `LabelHead`: label in **ink** mono caps on paper with a hairline under it.
   - New `EmptyRow({ name, onAdd })`: a 36px row on bone, the name in sans `text-ui` graphite, `+` in graphite at title size on the right. The whole row is the button. Rows stack with a 1px rule between them. Retire `RailEmpty` (`record-parts.tsx`) and point its 4 consumers at `EmptyRow`.
   - New `FoldRow({ hidden, onShow })`: 40px, 1px rule top, `px-3`, sans `text-label` graphite `25 more`.
4. **Casing primitives:**
   - `ui/label.tsx`: from mono 11 lowercase to `text-label text-graphite` sans, 6px above the control; an error goes under the control in destructive 12.
   - `RecordTable` `HeaderCell`: drop `field-label` and the explicit `lowercase`. Heads are sans 12 graphite; the sorted head is ink with ` ↑`/` ↓` after the label; numeric heads are right-aligned.
   - `field-label` in `styles.css` loses its `text-transform` and stays only for mono data words in end lanes.
   - The source strings are already sentence case, so no string edits are needed.
5. **`PropertyGrid` and `PropertyCell`** (`record-parts.tsx`):
   - A 1px rule box. The label cell is 112px, bone, `py-2 px-[10px]`, with a 1px rule on its right, in sans `text-label` graphite. The value cell is paper with the same padding, `text-ui`; numbers and years in mono, an option as a Badge.
   - Rows are separated by a 1px rule.
   - `PropertyFold` becomes a foot: 32px bone, `pl-[10px] pr-1`, `9 empty` in sans label graphite, and a 24px `+` that opens the add-attribute popover. `Show all · n empty` goes.
   - `RailRow` labels follow the same casing.

**Acceptance criteria**

- [ ] Tabs render no `0`; a render test covers empty, count and open.
- [ ] Segmented has one size and no `hint`, and the five hand-rolled radiogroups use it.
- [ ] `Band`, `EmptyRow` and `FoldRow` exist with render tests; `RailEmpty` is deleted.
- [ ] No `lowercase` class is left on labels, column heads or property labels (a grep test, or extend gate 5).
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-2` · afk · L — One date formatter, every call site (shared pieces 2)

**Blocked by:** `port-1` (serialise with it; together they touch about 45 files).

**What to build.**

1. **In `packages/core/src/format.ts` (pure, no `Intl`):**
   - `formatDay(iso, today)` → `13 Oct` | `4 Oct 2024`.
   - `formatWhen(iso, now, { readout? })` → `10:42` today (or `Today` when `readout`) | `13 Oct` | `4 Oct 2024`.
   - `formatDue(day, today)` → `−2d` overdue | a weekday (`Fri`) within 7 days | `14 Oct`.
   - `formatAge(iso, now)` → `12d` under 30 days, else `formatDay`.
   - Weekday heads: `THU 15 OCT` for bands, `Thu 15 Oct` in prose.
   - `today` and `now` always come from the loader, so the server and the browser print the same string.
   - Delete `formatDate`'s `Intl`.
2. **Replace every formatter and raw slice** (about 130–150 sites in about 45 files):
   - `stamp` in `packages/core/src/interactions/write-up-title.ts` and its re-export `lib/timeline/stamp.ts`.
   - `readoutDay`, `readoutDayAgo` and `readoutDayUntil` (`lib/records/readout-format.ts`).
   - `isoDay` and `DateCell` (`components/table/cells.tsx`).
   - `dayMonth` (`lib/documents/files-tab.ts`).
   - `weekdayDate`, `dayLabel` and `meetingWhen` (`lib/meetings/day.ts`).
   - `dayHead` and `pastWhen` (`lib/meetings/list.ts`).
   - `todayStamp` (`lib/today/needs-you.ts`), giving `Thu 15 Oct · W42`.
   - `whenLabel` (`today/rail.tsx`).
   - `byDay` (`lib/ask/thread-list.ts`) and the day dividers in `ask/ask-thread.tsx`.
   - The date code in `routes/_app/tasks.tsx`.
   - Every `.slice(5, 10)` and `.slice(0, 10)` printed as a date, and every `.slice(11, 16)` printed as a time, in: `ui/stamp.tsx`, `record/where-from.tsx`, `space-tabs.tsx`, `space-watching.tsx`, `record-notes.tsx`, `notes.tsx`, `files/viewer-sidebar.tsx`, `files/newer-version-dialog.tsx`, `fx-ledger.ts`, `lib/connections/accounts.ts` (`syncStateOf` → `In sync · 9 Oct`), `connection-apps-section.tsx`, `embeddings-section.tsx`, `settings/usage.tsx`, `settings/models.tsx`, `enrichment-section.tsx`, `today/notices.tsx`, `files/revision-ledger.tsx` and `mandate.tsx`.
3. `formatSince` and `agoOf` are ages; they stay, routed through `formatAge` where they print.
4. **A guard:** a test or lint rule that fails on `.slice(5, 10)` or `.slice(11, 16)` over a date-named value in `apps/web/src`.

**Acceptance criteria**

- [ ] Unit tests for the four forms, the year boundary, the 30-day age boundary and the due forms.
- [ ] No `MM-DD` is printed anywhere (the grep guard is green).
- [ ] No `Intl.DateTimeFormat` remains in `packages/core` or `apps/web/src`.
- [ ] Gates: typecheck, test (affected: web, core, worker), lint, prettier.

---

#### `port-3` · afk · L — Keys into tooltips, one `···`, page heads, stamps (shared pieces 3)

**Blocked by:** `port-2`.

**What to build.**

1. **Keys into tooltips (A2).**
   - Add `shortcut?: string` to `Button`. It renders an ink tooltip: `px-2 py-1`, the label in sans `text-label` paper, then the key in mono at 85% opacity, gap 10. Example: `Log interaction  L`.
   - Delete `KeyHint`, `ButtonPending`, `useButtonPending` and `keyHintClasses`. `pending` swaps the label and holds the width, with no spinner.
   - Move the key out of every control. There are about 42 sites in about 33 files:
     - Record heads: `deals_.$dealId`, `companies_.$companyId`, `people_.$personId`, `o_.$objectSlug.$recordId`.
     - List heads: `deals`, `people`, `o.$objectSlug`, `notes`, `today`, `spaces-index`, `space-page`.
     - `create-company-dialog`, `needs-you`, `record-notes`.
     - Every dialog primary with `⌘↵`: `ui/confirm-dialog`, `settings/settings-form`, `attribute-dialog`, `object-dialog`, `log-interaction-dialog`, `deal-board`, `space-move-dialog`, `space-watching`, `space-glossary`, `bulk-enrich-dialog`, `draft-composer`, the five import wizard files and `mandate`.
     - The auth `↵` on `login`, `join` and `setup`.
   - **Keys stay printed** in: the sidebar lane, Cmd-K rows, the `?` sheet and composer end lanes (`task-composer`, `tasks-rail`, `space-tag-row`, `details-add`, `space-tabs`, `spaces-index`).
   - Fix the `DialogFooter` comment that says the primary carries `⌘↵`.
2. **`MoreMenu({ variant: 'head' | 'row', items })`**, a new primitive.
   - The head trigger is a boxed 32px `icon` button with a 1px hairline. The row trigger is `icon-xs` 24px on bone-deep and shows on row hover and focus.
   - The menu is paper with 1px ink and the 4px dither; rows are 28px with a bone highlight; a destructive item sits below a separator.
   - **It renders nothing when no item is enabled. With one item it renders that item as an outline button (A7).**
   - `Copy link` swaps to `Copied` for about 1.2s and the menu stays open.
   - Replace the 14 hand-spelled triggers:
     - `table/list-menu`, `record/record-more-menu`, `record-timeline`, `space-page`, `record-files`
     - `settings/settings-section`, `email/draft-composer`, `ask/find-table`, `routes/_app/ask`
     - `notes_.$noteId`, `files/folder-band`, `views/view-bar`, `attributes/registry-list`, `files/file-row`
   - Fix the corrupted class token at `ui/dropdown-menu.tsx:59`.
3. **`PageHeader`:**
   - Delete the `count` prop; the count moves to the All tab. A page with no tab bar passes its count through the title slot.
   - `tabs` takes the `Tabs` bar.
   - The head is `[outline?] [Primary] [···]` at 32px.
   - Keep `eyebrow` and `description` for the pages that still use them; the surface slices remove them.
4. **`RecordHeader`** (`record-parts.tsx`):
   - The stamp gets its own row above the title. Delete `crumb` and add an inline `suffix` (mono micro graphite for a parent path, sans `text-ui` graphite for a person's role).
   - Actions are bottom-aligned with the title row (`items-end`, `gap-2`).
   - Stop rendering `readouts`; keep the prop until `port-R2` removes its callers.
5. **Stamp** (`styles.css` `.stamp`, `ui/stamp.tsx`):
   - A plain rectangle: no clip-path, 22px, `px-[10px]`, an ink fill, mono `text-micro` with 14px leading and `tracking-label`, caps, weight 500, paper text.
   - Delete `fact`. Add `state?: 'sensitive' | 'archived'`: sensitive appends a lock and `SENSITIVE`; archived is a 1px ink border on paper with `ARCHIVED` and the day.
   - `spaceStamp` drops `· depth n`, and the holding drops its id.
6. **`HeadBar`** (`head-fold.tsx`):
   - `px-4`, the title in `text-title`, and an optional `meta` (mono micro graphite, baseline).
   - Folded actions render at 26px with `right-4`.
   - The record bar shows a 16px mark in a hairline box instead of the stamp.

**Acceptance criteria**

- [ ] A lint rule (gate-5 style) rejects `<kbd>` or a key-hint child inside `Button` or `DropdownMenuItem`, outside the listed lane components.
- [ ] `MoreMenu` tests: no enabled item → null; one item → a button; destructive below a separator.
- [ ] `PageHeader` has no `count`; `RecordHeader` renders no readout strip; the stamp has no clip-path.
- [ ] Gates: typecheck, test, lint, prettier; web build + client-bundle check.

---

#### `port-4` · afk · M — Windows chassis, Twinkle and toasts (shared pieces 4)

**Blocked by:** `port-3` (both touch dialog feet).

**What to build.**

1. **`ui/dialog.tsx`:**
   - The scrim goes from `bg-black/50` to `bg-hairline/50`.
   - Add `size: 's' | 'm' | 'l' | 'viewer'`:
     - s = `sm:max-w-[27.5rem]`;
     - m = `sm:max-w-[35rem]`;
     - l = `sm:max-w-[48rem] max-h-[85vh] flex flex-col`;
     - viewer = `sm:max-w-[72rem] h-[85vh] p-0 flex flex-col`.
   - Delete every per-caller `sm:max-w-*` (about 35 files):
     - **S:** `confirm-dialog`, `newer-version-dialog`, `space-move-dialog`, the email `WidenDialog`, `templates`, `spaces-index`, `view-bar`, `members`, `object-dialog`, `ask`, `deal-board` (both), `portfolio_.$holdingId` (×4), `task-composer`.
     - **M:** `log-interaction`, `upload`, `link-folder`, `bulk-enrich`, `storage-picker`, `relationship-dialog`, the create dialogs.
     - **L:** `email-dialog`, `compose-windows` (×2), `meeting-dialog`, `keyboard-help`.
     - **Viewer:** `document-preview`.
     - **Exceptions, kept and commented:** `attribute-dialog` (fixed height) and `ui/command.tsx` (Cmd-K owns its size).
   - **Stacking:**
     - A `WindowStack` context. A nested `DialogContent` sets `top: parentTop + 56px` and `translate-y: 0`, with its own scrim at `bg-hairline/30`.
     - At depth 2, opening another window is refused (a dev assert).
     - Esc closes the top window only.
     - Popovers inside a window use the window's content as their `collisionBoundary`.
   - **Window landing:** the solid offset grows 0→3px in 3 steps over 180ms, replacing the .95 scale.
2. **`ui/confirm-dialog.tsx`:**
   - Drop the crimson or pine square from the head.
   - `keep` defaults to `Cancel`.
   - Add `note?: string` and pass it to the foot (e.g. `Can't be undone`).
   - Focus starts on Cancel.
3. **`Twinkle`**, a new `components/twinkle.tsx` beside `dither.tsx`:
   - A 4×4 grid of 2px dots with 2px gaps, 1-bit, 6 of 16 lit.
   - The lit set steps through `BAYER` order every 150ms in a 2.4s loop, and holds still under reduced motion.
   - Sizes: 14px in a row's mark slot, 29px in an empty pane. Ink on rule, or paper on graphite inside a toast.
   - Amend the `dither.tsx` docblock ("never animated" → "only for a working state").
4. **`ui/sonner.tsx`:**
   - No icons for success, info, warning or error. `loading` uses `<Twinkle/>` instead of `Loader2Icon`.
   - The toast is ink, `h-row`, `px-3`, `text-ui` paper.
   - **Action:** sans, underlined, paper (`Undo`), with a 1px paper drain line under the text that shrinks over the toast's duration.
   - **Error:** `bg-destructive` with a `×`, and it stays until dismissed.
   - **Motion:** enter translateY 8→0 with a fade over 180ms; exit 120ms.

**Acceptance criteria**

- [ ] No `sm:max-w-` is left on a `DialogContent` call, apart from the two commented exceptions (a grep test).
- [ ] A stacking test: the child offset is 56, Esc closes the child only, and a third window throws in dev.
- [ ] `Twinkle` honours reduced motion; no `animate-spin` remains in `apps/web/src`.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-R1` · afk · L — Record heads, the `···` and the record notices band

**Blocked by:** `port-4`.

**What to build.** Every record head follows one pattern:

- `pt-5 pb-4 px-6`.
- Row 1: the stamp, alone.
- Row 2: the 28px mark, the name in `title-serif` (28/32, 600, −0.01em), then the optional suffix.
- The verbs at the right of row 2.
- Then the double rule. There is no readout strip.

1. **Verbs per kind:**

   | Kind          | Suffix                                        | Verbs                                                                                                 |
   | ------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
   | Company       | none (the domain and alias suffix goes)       | `Log interaction` · `Enrich` · `···`                                                                  |
   | Person        | `<role> · <company>`, sans `text-ui` graphite | `Log interaction` · `Enrich` · `···`                                                                  |
   | Deal          | the stage badge                               | `Log interaction` · `Move stage` · `···`                                                              |
   | Holding       | none                                          | `Record a mark` · `Record a check` · `···`                                                            |
   | Custom object | none                                          | `Log interaction` · `···` when the object has a relation attribute targeting person, else `···` alone |
   | Term          | `Terms / <parent>`                            | `Write a note` · `···` (the filled rail button goes)                                                  |
   | Space         | `Spaces / <parent>`                           | `···` only                                                                                            |

2. **Removed from every head:** `SensitiveToggle`, `SummarizeRecordButton` (its job is `Ask about this`), `Note about this`, `Task`, `SaveAsTemplateAction`, the holding's `Company record ›` (the holding's title links to the company instead), the space's `Note here`, `Add watch` and Sensitive button, and every printed key. Keys stay bound and appear in tooltips.
3. **The head `···` (`RecordMoreMenu`, through `MoreMenu`):**
   - `Ask about this` · `Copy link` · `Save as template…`
   - then a rule and `Sensitive` with a switch;
   - then, when installed plugins offer actions, a mono caps group label (the plugin name, e.g. `EXA`) and its items, absent while the plugin is unhealthy;
   - then a rule and `Archive` in destructive, **only once `port-B4` lands** (A7).
   - Space menu: `Find companies` · `Rename` · `Move to…` · `Split into a subspace…` (renamed from `New subspace`) · `Save as template…` · `Glossary…` (D18) · `Sensitive` · rule · `Archive`.
4. **Plugin verbs (amended D63):**
   - `record/plugin-actions.tsx` stops rendering head buttons and the LedgerFigure, and hands its actions to the menu.
   - Completion is an ink toast fed by the `job_status` stream, e.g. `Exa found 5 · brief in Review` with an underlined `Review`.
   - Host `Enrich` stays a head verb. While a run is in flight its label reads `Enriching…` in graphite.
5. **`RecordNotices`**, a new band under the double rule. Bone, rule border, 34px rows, each a 6px square, a sentence in sans `text-ui` and a mono link:
   - Duplicate (amber): `Possibly the same as <name> · <key> on both` with `Compare ›`. **Server:** an open identity suggestion or a dedupe pair for this record.
   - Parked (amber): `Enrich parked · Apollo limit reached · runs at 00:00 UTC` with `Enrichment ›`. **Server:** extend `getRecordEnrichment` from `parkedEnrichmentProgram`.
   - Archived: drawn on the board but waits for `port-B4`.
6. **States:** loading through the route `pendingComponent` (the mark twinkles, the title is graphite, no verbs); sensitive through `Stamp state="sensitive"`.

**Files:**

- `record-parts.tsx`, `record-more-menu.tsx`, `record/plugin-actions.tsx`, `sensitive-toggle.tsx`
- the head blocks of `companies_.$companyId`, `people_.$personId`, `deals_.$dealId`, `o_.$objectSlug.$recordId`, `terms.$termId`, `portfolio_.$holdingId` and `components/space-page.tsx`
- a new `record/record-notices.tsx`

**Acceptance criteria**

- [ ] A render test over all seven kinds asserts the exact verb labels and that the `···` exists.
- [ ] No head renders Sensitive, Summarize, Save as template, Note about this or a key.
- [ ] Plugin actions appear only in the `···`, under their plugin's label.
- [ ] The notices band renders duplicate and parked lines from the new reads.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-R2` · afk · L — The Overview tab and the record rail

**Blocked by:** `port-R1`.

**What to build.**

1. **Overview tab.**
   - Add `overview` first in `RECORD_TABS` (`lib/records/record-tabs.ts`) and make it the default. **It always opens; drop per-kind tab memory (D1).**
   - Tabs read `Overview · Notes · Interactions n · Files n · History n`. Overview carries no count.
2. **`record/record-overview.tsx`**, a new component, top to bottom:
   - **Readouts row:** 76px, `px-3`, rule under. The first cell is 220px with a rule on its right; later cells are 180px with `pl-4`. The value is mono `text-page`; the label is sans `text-label` graphite. **Only readouts with a value show: no `—`, no 0 count.** The readouts are each route's current readout props, moved here.
   - **`Band TASKS … All tasks ›`:** task rows (40px, a 14px hairline checkbox, the content in `text-body` ink, and a 72px mono due lane through `formatDue`, in destructive when overdue). Then the composer `+ Add a task…` with `T` in its end lane. `All tasks ›` goes to `/tasks?record=<id>`; **add that search param and loader filter to `routes/_app/tasks.tsx`.**
   - **`Band LATEST … All interactions ›`:** the latest 3 threads as `ThreadRow`.
   - **`Band FILES … All files ›`:** the latest 3 files as 40px rows (glyph, name in `text-ui`, the person who filed it in a 252px lane, the day in a 72px lane).
   - The tab links call `changeTab`.
   - **First run:** no readouts, then `EmptyRow`s `Tasks +`, `Interactions +` and `Files +`.
3. **`ThreadRow`**, extracted from `record-timeline.tsx`:
   - Padding `py-[9px] px-3`; line 1 is 20px with `gap-3`.
   - Lanes: a 14px glyph in a 16px lane; the subject in `text-ui` ink, with a mono micro graphite message count after it when above 1; people in 200px, `text-label` graphite; a paperclip lane of 40px (12px clip plus mono count); the day in 72px, mono micro graphite, right-aligned.
   - Line 2 is the summary in `text-label` graphite, `pl-[28px] pr-[324px]`, and is absent when there is no summary.
   - **H2:** the viewer is never in the people lane, and a sent row reads `To <name>`. The loader needs a sent-direction flag.
4. **Rail:**
   - 300px, bone, `p-3 gap-3`, hairline on its right edge.
   - It holds the attribute grid (`port-1`'s PropertyGrid; a fold row `n empty +` opens a popover with search `Add an attribute…`, rows of name and mono type, and a foot `New attribute…` that opens `AttributeCreateDialog`) and the relations.
   - The edit hint under the grid while editing: mono micro `↵ save   esc revert   ⇥ next cell`.
   - Relation sections: the head in sans `text-ui` graphite with `+` (or a count) on the right; rows in sans ink on rules; an empty section is an `EmptyRow`.
     - `Team`: each row's role in mono caps (`CEO`).
     - `Associated deals`: each row with its stage badge.
     - `Spaces +` opens a popover: search `Add to a space…`, rows of path and mono count, and a last row `✦ Suggest spaces`. Remove the separate `SuggestSpacesAction` button.
     - `Waiting n` lists open suggestions with their titles (`✦ Founders from Apollo +3`). **Server:** a new query beside `countOpenSuggestions` that returns titles.
   - Remove `TasksRail` from every rail; its fetch moves into Overview.
5. **Remove the `readouts` prop** from every record route and from `RecordHeader`.

**Files:** `lib/records/record-tabs.ts`, `record/record-tabs.tsx`, the new `record/record-overview.tsx`, `tasks-rail.tsx`, `record-timeline.tsx` (extraction only), `record-parts.tsx`, `property-fold.tsx`, `relation-section.tsx`, `spaces-section.tsx`, `suggest-spaces.tsx`, `waiting-rail.tsx`, `lib/timeline/record.ts`, `routes/_app/tasks.tsx`, and the four tabbed record routes.

**Acceptance criteria**

- [ ] Overview is the default and first tab on company, person, deal and custom records; a test covers readout value filtering and the three bands.
- [ ] `/tasks?record=` filters.
- [ ] `ThreadRow` drops the viewer and prints `To X` on sent rows (unit test).
- [ ] The rail has no tasks and no absence sentences.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-R3` · afk · L — Record tab bodies: Notes, Interactions, Files, History

**Blocked by:** `port-R2`.

**What to build.**

1. **Notes** (`record/record-notes.tsx`, `lib/notes/list-record.ts`):
   - Delete the filter row.
   - The composer `+ Write a note…` with `N` in its end lane.
   - Filed notes come first (memos first), then `Band FROM MEETINGS` and the meeting notes. A superseded note comes last as a single 40px graphite line.
   - **Row, line 1:**
     - a 16px glyph (`¶` serif graphite for a note, a calendar glyph for a meeting);
     - the title in serif `text-title` ink;
     - people in 200px (the author, or the attendees);
     - a mono kind lane: `memo`, `scratch`, `via Granola` or `superseded`, never `note`;
     - the day in 72px.
   - **Row, line 2:** an excerpt in `text-label` graphite, `pl-[28px] pr-[120px]`.
   - **Loader:** the author name (`note.authorId` → `user`), an excerpt (about the first 160 characters of `body_md`, stripped), the attendee names, and `supersededBy`.
   - Empty: `Notes +`.
   - `recordTabCounts.notes` no longer follows a filter.
2. **Interactions** (`record-timeline.tsx` `RecordInteractions`, `lib/timeline/record.ts`):
   - **Toolbar** (48px, rule under): a Segmented `All · Email 17 · Meetings 5 · Calls 2` (All uncounted) on the left, and a toggle `With files 7` on the right.
   - **No composer:** remove the `composer` prop from every route; the head's `Log interaction` is the control.
   - Week bands `THIS WEEK` · `LAST WEEK` · `EARLIER`.
   - **One `ThreadRow` per `interaction.thread_id`** with a message count (server grouping; the column exists).
   - `Write up` moves into the row `MoreMenu`: `Open · Write up · Copy link · File on a deal… · rule · Unlink from <record>…`.
   - **Server:** `fileInteractionOnEntity` and `unlinkInteractionFromEntity` (an `interaction_entity` insert and delete).
   - Empty: `Interactions +`.
3. **Files** (`record-files.tsx`, `storage-picker.tsx`):
   - The add row reads `+ Drop files, or paste a Drive link…`, then an outline sm `Upload`, then a row `MoreMenu` holding `Attach from Drive` and `Link a folder…` (renamed from `Link a Drive folder…`).
   - The `···` renders only when a Drive connection exists.
   - Delete the add-row totals.
   - Kind bands become `Band` with the count after a space (`DECK 2`).
   - The end lanes are mono micro:
     - `4.1 MB · 13 Oct`;
     - superseded: `3.8 MB · 14 Aug · → v3`, with the row in graphite;
     - followed: `rev 4 · 10 Oct · following`;
     - from email: `42 KB · 9 Oct · via Gmail`.
4. **History** (`RecordHistory`, `Row`):
   - Week bands.
   - **Rows (40px):** a glyph lane (mark ■, stage ▤, enrich ✦, file ▯, burst `›`, merge ⇄, space layers), a sentence (`Priya Raman recorded a mark`), a mono figure lane, and the day.
   - Figure lane examples: `$4.5M` · `Diligence → Term sheet` (badge on the new stage) · `6 attributes` · `Q3 board deck.pdf` · `Team size, Location, +1` · `Exponent Labs` · `Proptech › Property ops` · `from an email`.
   - The facts come from `activity.meta`, joined for the document name, the space path and the merged name. **Server only, no migration.**
   - Pages at 25 with a `FoldRow`.
   - An expanded burst: a bone header row `⌄ Priya Raman changed 3 attributes`, then rows with the label in sans graphite and the change in mono `90 → 120` (options as badges).
   - Deals lose their history filter row.

**Acceptance criteria**

- [ ] Notes: excerpt and supersede ordering tests.
- [ ] Interactions: thread grouping and the Segmented counts.
- [ ] Files: the `···` is absent with no Drive connection.
- [ ] History: the figure lane for each activity kind.
- [ ] No record tab body prints an absence sentence.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-R4` · afk · M — The space page and the holding

**Blocked by:** `port-R2` (Overview pattern, Band, EmptyRow). It can run beside `port-R3` (disjoint files).

**What to build.**

1. **Space** (`space-page.tsx`, `space-tabs.tsx`, `space-watching.tsx`, `lib/spaces/page.ts`, `routes/_app/spaces_.$spaceId.tsx`):
   - **Head:** done in `port-R1`.
   - **Tabs:** `SPACE_TABS` gains `overview` first, and it is the default: `Overview · Companies n · Notes n · Files n · People n`. `Records` shows in graphite with no count at 0.
   - **Overview:**
     - Readouts `3 of 14` / `In pipeline`, `6 Oct` / `Last filed`, and the funding-stage dither bar / `Funding stage`.
     - `Band WHAT'S MOVING … All signals ›`, with rows of headline and day. `All signals ›` is a `FoldRow` that expands in place, since no signals page exists.
     - `Band TASKS … All tasks ›`, task rows and the `+ Add a task…` composer.
     - `Band LATEST COMPANIES … All companies ›`, with rows of mark, name, stage badge and filed day.
   - **Rail:**
     - `Criteria` in serif.
     - `Watching +` (its `+` replaces the `Add watch` head button), with rows `Exa · companies` / `weekly · 2h ago` / `Run now`.
     - `Map n sub`: `↑ <parent>`, then children with counts, then `+ Subspace`.
     - Glossary and Tasks leave the rail.
   - **Companies tab:**
     - A Segmented `All · In pipeline 3 · Watching 11`, with `Sort Funding stage ▾` on the right.
     - The composer `+ Tag a company into <space>…`.
     - Column heads `Company · Funding stage · Pipeline · Location`; the Pipeline lane reads `watching` or `1 deal`.
     - Hover shows a checkbox and `×`.
     - The foot reads `7 more · seed 3, pre-seed 3, bootstrapped 1`.
2. **Holding** (`routes/_app/portfolio_.$holdingId.tsx`). One view, no tab bar.
   - **Figures row** at the top of the pane: `Invested`, `Value · marked 13 Oct`, `MOIC`, `XIRR`, each shown only with a value (`Realized` only when above 0).
   - **As-of control:** an outline `As of <day> ▾` date control at the right. **Add `validateSearch({ asOf })` and a loader dep**; `getHolding` already takes `asOf`.
   - **Sections** in order Checks · Marks · Distributions · Rounds, each a `SectionHead` with a count.
     - **Check rows:** a day lane, `SAFE · Northgate Fund II`, a mono detail `cap $12M`, and the amount on the right.
     - **Voided original:** struck through. The compensating row is indented under it: `Voided by <name> · <day>` · `compensating entry` · `-$1,000,000`.
     - Void moves into the row `MoreMenu` (the confirm is unchanged). The inline `void` word goes.
     - Empty sections are `Distributions +` and `Rounds +`.
     - **No section composers (D2).**
   - **Rail** (right, bone): `Ownership` · `fully diluted`, with rows `10 Mar 2025 Seed 250,000 / 4,100,000 6.1%`.
   - The title links to the company record.

**Acceptance criteria**

- [ ] Space: Overview is the default and holds the readouts; the rail has no Glossary or Tasks; the Companies tab uses a Segmented.
- [ ] Holding: `?asOf=` recomputes the figures (test); void sits in `···`; Realized is hidden at 0.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-L1` · afk · L — The list chassis: head, view bar, filter chips, table, states

**Blocked by:** `port-4`. It can run beside `port-R1` only if `record-table.tsx` is not touched there; it isn't.

**What to build.** This applies to Companies, People and custom `/o/$slug`. Deals and the shelves are `port-L2`.

1. **Head:**
   - The serif title with **no count**, then `[New <x>]` filled 32 and a `MoreMenu` head.
   - `ImportAction` moves into `ListMenu`. The menu order is `Import…`, `Enrich…`; Export is out of the project.
2. **ViewBar** (`views/view-bar.tsx`), the 44 bone `Tabs` bar:
   - The tabs are the views.
   - `+ view` becomes `Save view…` (mono 11 primary).
   - **Right side:** Filter · Sort · Columns as plain sans 13 ink text at rest with no icons, then a search box 180×26 with the placeholder `Search <plural>`.
   - **When a tool is active**, it renders as an outline box: `Filter 1`, `Sort Last contact ↓`, `Columns 9/15`.
   - **A dirty view:** a pine square after its count, then `[Update view]` outline and a `···` with `Pin to sidebar` / `Unpin from sidebar`, then a rule, then `Rename…` and `Delete view` (destructive).
3. **Filter chips** (a new `views/filter-chips.tsx`), a 36px row under the bar, shown only while conditions exist:
   - Each chip: 24px, radius 2, paper, `border-rule`, `px-2 gap-1.5`. `<Attribute> is` in sans 12 graphite, the value in sans 12/500 ink, then `×`.
   - On × hover the chip takes an ink border and the × sits on bone.
   - `Add condition` in mono 11 primary; `Clear` in sans 12 graphite on the right.
   - **Filter popover:**
     - Empty, it opens straight into the attribute picker; a pick creates the condition and focuses the operator.
     - Condition rows read `[attr ▾] [is ▾] [value ▾] ×`.
     - The foot holds `[Add condition]` and `Clear`.
     - Delete the sentence `No conditions. Every record shows.`
4. **Table** (`table/record-table.tsx`, `cells.tsx`):
   - Column heads come from `port-1`. Companies' name head becomes `Name`.
   - The head menu gains `Edit attribute…`, which opens the existing attribute editor.
   - The Columns menu head reads `COLUMNS · 9 OF 15` with `Reset`.
   - Column resize shows a dashed body guide while dragging.
   - `DateCell` and the stat columns use `formatDay` / `formatAge` (D5).
   - The AI column head carries an `AI` tag. AI cells read `Strong AI · 12 Oct`, or `— Proposed ›` in pine.
   - The column-run dialog title is `Run <column> on <view>?` (no quotes, no body sentence), with the note `Lands in Review · stops at today's cap`.
   - The Save view dialog: the subtitle is the list's plural, then `Name`, a `Private | Shared` Segmented, and `Cancel` · `Save`.
   - **Foot:** shown only while paging. `<loaded> of <total>` on the left and `Load 50 more` on the right (`Loading…` while fetching). `end` goes.
   - The ViewBar pins under the 40px HeadBar, with the column head stacked under it.
   - **Long tables:** a sticky name column with a rule on its right edge, and a fade on the right edge when `scrollWidth > clientWidth`.
5. **States:**
   - **First run:** the head shows only `[···]` (the primary hides), and the body is one `EmptyRow` with the plural (`Companies +`), which creates. Replace `EmptyState` on these lists.
   - **Zero results:** `Nothing matches that filter.` with `Clear filter` in pine. The open tab shows its 0 when it is dirty.
   - **Loading:** a Twinkle row `Loading companies`.
   - **Error:** a destructive square, `Could not load companies · the database did not answer`, and `[Retry]` (calls `refetch`).

**Acceptance criteria**

- [ ] A render test over the three list routes asserts a head of `[New x] [···]`, no title count, and Import inside `···`.
- [ ] The chips row adds, removes and clears conditions; the empty Filter opens the picker.
- [ ] The foot renders only while paging.
- [ ] The first-run row, the zero-results line, the loading row and the error row each have a test.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-L2` · afk · M — Selection, the row `···`, Deals, Portfolio and Files shelves

**Blocked by:** `port-L1`.

**What to build.**

1. **SelectionBar** (bone, 44px, replaces the ViewBar while rows are selected): `n selected` · `[Add to space]` outline · `[Enrich…]` outline, with `Clear` in sans 12 graphite on the right. There is no Tag action. Wire it on Companies, People, `/o/$slug` and, newly, Deals.
2. **Add-to-space window** (S):
   - Title `Add 3 companies to a space`; a `Space` field with a path picker (`Proptech / Property ops`); `Cancel` · `Add 3`.
   - On success the toast `3 companies added to Property ops` appears with `Undo`, and the selection clears.
   - **Server:** `tagManyIntoSpace` (one transaction over `tagByHand`), with Undo through `untagFromSpace` per id.
3. **Bulk Enrich window:**
   - The subtitle is `Selected` or `This view`.
   - Rows: `To ask n` · `Skipped, sensitive n` · `Already enriched this week n`. The per-source split goes to a tooltip.
   - Foot note `About n credits · n left today`, then `Enrich n`.
4. **Row `···`** (`MoreMenu` row variant, in the 40px trailing lane, shown on hover):
   - `Open in a new tab` · `Add to space…` · `Enrich…` · `Copy link`.
   - `Archive` arrives with `port-B4` (D4).
   - On hover the name is underlined.
5. **Deals** (`deals.tsx`, `deal-board.tsx`, `lib/server/deals.ts`):
   - Bar tabs: `All 28 · In diligence 2 · Live pipeline 9 · Post-mortems 5`.
   - Right side: a boxed Stage chip `Stage Active 9 ▾` (a popover of groups and stages with counts, still stored in `extra`), then Filter · Sort · Columns, then a **Segmented `Table | Board`** (D3, stored in `localStorage dealos.deals-view`), then search. The second FilterRow and the `···` › Show as board go.
   - Columns: `Deal · Stage · Value · Owner · Source · Close date · Last contact`. Company is hidden by default. Last contact needs `stats` on `listDealsTable` (server).
   - **Board column head:** line 1 is the stage badge with the count on the right; line 2 is mono `$0.5M` on the left and `Median 4d` on the right; an ink rule follows.
   - **Board card:**
     - the name;
     - `$150K · Inbound` with the days in stage on the right (destructive when late);
     - `Close 15 Nov · 31d` only when a close date is set;
     - no owner initials.
   - The drop target reads `Drop → <stage>`, dashed pine. TerminalSplit and `drag to move` go.
6. **Portfolio** (`portfolio.tsx`):
   - No tab bar. The title carries the count (`Portfolio 12`).
   - The head is `[Record a check]` outline + `[···]`. Lift `AddInvestmentDialog` out of the holding route and give it a company picker; `addInvestment` already takes `companyId`.
   - Search moves into the `···`'s first item `Search…`, and Sort and Columns move into the `···`.
   - The headline strip stays only with non-zero figures.
   - Columns: `Company · Invested · Current value · Realized · Ownership (~2.1% when estimated) · MOIC · Gross XIRR · Last mark`.
7. **Files shelf** (`files.tsx`, `lib/documents/shelf.ts`):
   - Tabs `All 48 · Unfiled 3`, with both counts loaded (`countUnfiledProgram`); drop the title count.
   - Columns: `File` (the kind glyph in the cell) · `Filed against` · `Space` · `Added by` · `Date` · `Size`. Kind, Source and Extraction go.
   - The exception lane shows `Extracting…`, or `Failed` (destructive mono) with `[Re-read]`, which calls `reExtractDocument`.

**Acceptance criteria**

- [ ] Bulk tag with Undo restores the prior state (integration test).
- [ ] The Deals Segmented persists; the Stage chip filters; the board strings match.
- [ ] Portfolio: no tab bar, and Record a check creates an investment with a picked company.
- [ ] Files: both tab counts and the exception lane.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-L3` · afk · M — Tasks, Notes, Meetings, Mandate, Spaces index, Review, Import

**Blocked by:** `port-4`. Disjoint from `port-L1` and `port-L2` except through primitives, so it can run beside either.

**What to build.**

1. **Tasks** (`tasks.tsx`, `task-composer.tsx`):
   - The head is `Tasks` with no description and no `···` (nothing to put in it, A7).
   - A bone band holds a right-aligned Segmented `Open 7 | Done 12`, in place of the caps `HeaderTab`s.
   - Groups are `LabelHead`s: `OVERDUE` (destructive), `TODAY · THU 15 OCT`, `THIS WEEK · THROUGH SUN 18 OCT`, `LATER`.
   - Rows: checkbox, title, the record in graphite, and a right figure through `formatDue`.
   - The row `···` holds `Open <record>`, `Due date…`, `Assign…`, `Copy link`, a rule, and `Delete task` in destructive. The hover trash icon goes.
   - The composer `+ Add a task…` with `T` is **the last row**.
2. **Notes** (`notes.tsx`):
   - Meta `14 notes · last edit 14 Oct`.
   - `[From template]` outline + `[New note]` filled.
   - Bone bands `This week 3` (no `W42` link) and `Earlier 11`.
   - Rows: `¶` · title · snippet · kind lane in mono caps (`MEMO`, `SCRATCH`) · `14 Oct`.
   - `Earlier` shows 20 rows, then a `FoldRow` `n more` that expands in place.
3. **Meetings** (`meetings.tsx`, `meetings/meetings-ledger.tsx`, `lib/meetings/list.ts`, `lib/server/meetings.ts`):
   - The Kit `Tabs` bar under the head: `All 16 · Upcoming 4 · Past 12 · No write-up 3 · Mine 9`.
   - Day heads: `TODAY · THU 15 OCT`, `FRI 16 OCT`, `PAST`.
   - **Upcoming rows:** `11:00`, the title, an attendees line (`Arjun Rao ✓`, `Dana Moreau ?`), record chips, `[Prep]`.
   - **Past rows:** `7 Oct`, then one of:
     - `■ No write-up` (warning) + `[Write]`;
     - the provider glyph + `Write-up · 2 tasks`;
     - `Write-up`;
     - struck and graphite with `Cancelled`.
   - The foot reads `8 earlier`. **Server:** the overflow count and the per-meeting task count.
4. **Mandate** (`mandate.tsx`):
   - Meta `Updated 12 Oct · 3 stages · 2 geos`, with `Saved 16:20` on the right.
   - Fact labels in sans 12 sentence case (`Stages`, `Geographies`, `Check size`).
   - Stage badges: selected ones tinted, the rest on bone, with `3 of 9` on the right.
   - Geography chips `India ×` plus an inline input (placeholder `Singapore…`) and a pine `+`.
   - `USD [100,000] – [500,000]`, with no `whole units` note.
5. **Spaces index** (`spaces-index.tsx`):
   - Head `Spaces` with the meta `11 spaces · 6 nested` and **no head button**.
   - Column heads on an ink rule, sans 12: `Space · Companies · Memos · Terms · Last filed`. Drop the `Market map` label.
   - Roots are bold with the layers icon; children get tree glyphs.
   - Last filed goes through `formatAge`.
   - The composer row `+ New space…` with `S` at the end. The foot is `1 archived` with `Show`.
6. **Review** (`review.tsx`):
   - Head `Review` + `[Scan for duplicates]` outline, with no description.
   - Kit tabs `All 6 · Suggestions 4 · Duplicates 2`.
   - Cards are flat (hairline, no `shadow-solid`).
   - **Suggestion card:** the serif name and a mono `Funding stage · via Apollo · 14 Oct`; a grid of `Proposed` · `Current` · `Confidence` · `Source`; a bone foot `Dismiss` / `Accept`. `Reject` becomes `Dismiss`.
   - **Pair card:**
     - title `A ⇄ B` + `Same domain · 9 Oct`;
     - a head row `Field | ☑ Keep · A | [⇄] | ☐ Merge in · B` (the swap button exchanges the keeper);
     - rows that are empty on both sides are hidden;
     - the foot note `No unmerge · a snapshot of B is kept`, then `Dismiss` · `Merge B into A`.
7. **Import** (`import/commit-receipt.tsx`, `import/preview-ledger.tsx`):
   - Preview badges in sentence case (`No land`).
   - The receipt's primary becomes `[Open companies]` (a link to the object list), with `[Retry failed rows]` outline. `Commit again ⌘↵` leaves the head.

**Acceptance criteria**

- [ ] Each page's head and band match the strings above (render tests per route).
- [ ] The Meetings counts come from the server.
- [ ] `Reject` no longer appears on Review.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-T1` · afk · L — Today: head, readouts, order and the Needs-you anatomy

**Blocked by:** `port-4`.

**What to build.**

1. **Head** (`routes/_app/today.tsx`):
   - A mono eyebrow `Thu 15 Oct · W42`, then the serif `Today`, with **no buttons**.
   - `T` stays bound to the composer. `L` opens `LogInteractionDialog` with no visible trigger; it also stays in Cmd-K page actions.
   - The folded head reads `Today` + `Thu 15 Oct`.
2. **Day strip:** render only when a calendar is connected (`meetings.calendar`). Otherwise it is absent (amended D79).
3. **Readout strip** (`components/today/readouts.ts`, `ReadoutStrip`):
   - Cells 240px. The figure in mono `text-page`; the label in sans 12 graphite.
   - **Only non-zero figures show, and the strip is absent when all are zero.**
   - Tone is destructive only when the figure is bad (Overdue, Oldest mark over 180d); the rest are ink.
   - **Each cell is a `button` with `aria-pressed`.** A click inserts a transient segment after `All` (`Overdue 2`) and selects it; a second click clears it.
   - The mappings: Overdue → late tasks; Deals past stage median → deal rows (**align `dealsPastMedian` with the deal-row set so the counts agree**); Oldest mark → mark rows.
   - `Unfiled files` stays a link (D17).
   - Lift the tab state from `NeedsYou` to `TodayLedger`.
4. **Body order:** Notices → Needs you → Meetings.
5. **Needs you** (`components/today/needs-you.tsx`, `lib/today/needs-you.ts`):
   - **Head:** a `SectionHead` `Needs you` with **no count**, and a Segmented on the right: `All · Tasks 4 · Review 3 · Meetings 1 · Deals 2 · Marks 1`. A kind at 0 has no segment.
   - **Every row** is 40px, `px-3 gap-3`, with these lanes:
     - kind, 64px, mono micro CAPS `tracking-label` graphite;
     - mark slot, 14px (checkbox, ▸/▾, file glyph, lock);
     - body, flexible: the primary in sans `text-body` ink, the context in sans 12 graphite, mono only for money or domains;
     - action, 120px (`Write`, `Prep`);
     - who, 120px, sans 12 graphite;
     - figure, 48px, mono micro, right-aligned, destructive when bad;
     - `···`, 24px.
   - **Who** per kind:
     - Task: the assignee, blank when it is the reader (H2).
     - Deal: the deal owner (**loader:** add the owner).
     - Meeting: the first external participant (**loader:** add it to `meetings.unwritten`).
     - Mark: blank.
   - **Figure:** `−2d` / `Today` / `2d`, or the clock for anything today (H3).
   - **Mark row:** the context is the holding value in mono (`$3.0M`); `last mark …` and `record mark ›` go. A click opens Record a mark with the holding prefilled.
   - **Fold:** show 8, and fold only when 3 or more would be hidden. The fold reads `3 more · 1 task · 1 review · 1 deal`, with `Show all ›` in sans ink.
   - **Composer:** a graphite `+` in the kind lane; `Add a task…` aligned to the body lane; a mono `T`.
   - **Loading:** defer the attention read, and show a Twinkle row `Loading what needs you`.
   - **Sensitive:** a lock in the mark slot, with the tooltip `Sensitive · AI never reads <name>` (**loader:** add `sensitive` to each item).
   - **Keyboard:** `J`/`K` move a reticle. On a task, `X` is done and `↵` opens. On a review row, `A` is the primary and `D` dismisses. The tooltips name them.
   - **Task row `···`:** `Open <record>` · `Due date…` · `Assign…` · `Copy link` · rule · `Delete task`.
6. **Rail** (`components/today/rail.tsx`), 360px, `p-5`:
   - Section heads in mono micro CAPS graphite with a rule under and no meta.
   - **Portfolio:** 32px rows of `Invested` / `Value` / `MOIC` with the value in mono `ui` ink. The missing-rates line (6px amber square, `1 holding out of the totals`, `Set rates ›`) shows only when needed; the block is absent with no holdings.
   - **What's moving:** rows of a 44px day lane (`formatWhen`), the title in sans ui ink, and a sub-line in sans 12 graphite. Capped at 4, with a foot row `5 more` and `Team activity ›`, which opens the team rows inline (`11:02 Anika Rao filed Q3 board deck.pdf on Exponent`, no verb code).
     - Quiet: `Nothing new.`
     - Loading: a Twinkle and `Reading signals`.
     - Failed: a rose square, `Could not load signals`, `Retry ›`.
   - Links are ink, never pine.
7. **First run:**
   - The setup blurb reads `Three fictional companies in data-center cooling, a memo and a small space tree.`, with the mono foot `Removed in one step from Settings › General`.
   - The `first-run.tsx` DitherBlock is ink.

**Acceptance criteria**

- [ ] The head has no buttons; the strip is absent without a calendar.
- [ ] Zero readouts are hidden; a readout click filters Needs you (test).
- [ ] The row lanes render for task, deal, mark and meeting; the H2 blank for the reader's own task.
- [ ] The fold rule is tested.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-T2` · afk · M — Today: proposals decided in place

**Blocked by:** `port-T1`, `port-B1`.

**What to build.** Today stops showing review groups only. It reads proposals one row each.

1. **A new read** (`lib/today/attention.ts`) flattens `listInboxProgram`'s rows:
   - one row per `SuggestionItem`;
   - `DiscoveryRow`, `ColumnRunRow` and `AskCardsRow` each become a group row with ▸/▾ and child rows;
   - `DuplicateCandidateRow` becomes one row.
   - The REVIEW segment counts the top-level rows.
2. **A pure `proposalLine(item)`** gives the body sentence per kind:

   | Kind              | Body                                    |
   | ----------------- | --------------------------------------- |
   | attribute_patch   | `Funding stage → Series A`              |
   | supersedes        | `Newer version of <name> · <record>`    |
   | space_tag         | `Belongs in <path>`                     |
   | document_kind     | `Kind → Cap table · <record>`           |
   | note              | `Note from <meeting>`                   |
   | ledger_event      | `Mark at $1.4M · Series A price, 3 Oct` |
   | captured identity | `Captured page · matches <person>`      |
   | meeting task      | `Task from <meeting>`                   |
   | duplicate         | `Possibly the same · <key> on both`     |
   | option proposal   | `New option "<x>" · for everyone`       |
   | add_record child  | `<domain> · <one-liner>`                |
   | file_record child | `Filed in <path>`                       |

3. **Who lane:** `Via <integration>`, `AI`, `Captured`, `Column run`, `Via Ask`, or the run's author.
4. **Hover verbs** replace the who and figure lanes, and the row goes bone. The buttons are 24px: `Dismiss` (ghost, ink sans 12 medium) plus a pine primary.
   - The primaries: `Accept`, `Mark as newer version`, `Add to space`, `Add note`, `Record mark`, `File on <name>`, `Add task`, `Add option`, `Add and file`, `File here`.
   - A duplicate shows `Not the same` (`dismissDuplicate`) and `Compare` (opens the pair in Review).
   - **No icons.** `Reject` becomes `Dismiss` in `decisionWords`, shared with Review.
5. **Group rows:**
   - The watch group offers `Open in Review ›`.
   - The column-run group offers `Open in Review ›` and `Accept all N` (D16). A partial refusal toasts `7 accepted · 2 refused, the values changed` with `Open in Review`.
   - The Ask thread group offers `Open thread ›`.
   - Child rows leave the kind lane empty, draw a rule line in the mark slot, and are decided in place.
6. **Every decision goes through `port-B1`'s hold.** The row leaves, and a toast holds Undo: `Accepted on Exponent  Undo`, `Rentwise dismissed from Property ops  Undo`, `9 accepted on <run>  Undo`.

**Acceptance criteria**

- [ ] The flatten read is unit-tested per kind.
- [ ] `proposalLine` has a table test.
- [ ] Hover verbs per kind are tested.
- [ ] Duplicates appear on Today.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-T3` · afk · M — Today: Meetings, the day strip and the notices band

**Blocked by:** `port-T1`. It can run beside `port-T2` (meetings, day-strip and notices files only).

**What to build.**

1. **Meetings section** (`components/today/meetings.tsx`; a new Today-only row component; **don't edit the shared `MeetingRow`**):
   - **Head:** a `SectionHead` `Meetings` with an ink count. On the right: `‹` · `Today` · `›`, then `All meetings ›`. On another day, `Back to today` comes first, then `‹ Wed 14 Oct ›`.
   - **Rows:**
     - a 90px mono start-time lane;
     - the title in sans body regular (graphite when past, ink when ahead);
     - an action lane of 120: `Write`; `Prep`; `Preparing…`; `Read prep`; a Twinkle with `Notes arriving`;
     - who, 120 (`Priya Raman +1`);
     - an empty figure lane;
     - `···`.
   - **Now rule:** a pine 6px square, `Now · 11:40` in mono, a hairline, and `Next in 2h 20m`.
   - **States:**
     - Cancelled: struck, with `Cancelled`.
     - Read failed: a rose square, `Could not read the calendar · Google did not answer`, and `[Retry]`.
     - No calendar: `No calendar connected` with `Connect Google ›`.
     - Member: `Ask <admin> to connect Google`.
     - Nothing today: `No meetings`.
   - `Read prep` and `Notes arriving` need stored prep and a recorder-pending flag, which do not exist. **Leave those two states out**; they are listed in the close comment.
2. **Day strip** (`components/today/day-strip.tsx`):
   - It takes the Meetings `day`. A past day is fully dithered with no now-dot; a future day has no dither.
   - Block labels are the first linked record, else the first external participant, else the title.
   - A hovered block gets a 1px ink outline and the tooltip `14:00–14:45` plus `<title> · <who>`. A click opens the meeting window.
3. **Notices band** (`components/today/notices.tsx`):
   - Bone, a rule border, 34px rows, `px-3 gap-2`. Each row is a 6×6 square (amber or rose ink), a sentence in sans `ui` ink, and a fix link in mono micro ink, all sentence case. Examples:
     - `Auto-enrich paused · Apollo limit reached · 14 waiting · runs at 00:00 UTC` with `Enrichment ›`;
     - `Gmail stopped syncing · Google said: token expired` with `Reconnect ›`.
   - The lowercase `reconnect ›` and `cap ›` become sentence case.
   - The `Reconnect ›` target changes in `port-B3`.

**Acceptance criteria**

- [ ] The day nav and the strip following the day are tested.
- [ ] The Meetings states render.
- [ ] Notices show squares and sentence-case links.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-W1` · afk · M — Small windows and create windows that ask only for identity

**Blocked by:** `port-4`.

**What to build.** Every window uses the `port-4` chassis. The foot is `note? · Cancel · Primary`, with no icons and no keys.

1. **Log interaction** (M, `log-interaction-dialog.tsx`):
   - A Segmented `Call · Meeting`, with no digit hints. The default kind is `Meeting`.
   - `About` and `When` (mono, w 176).
   - `Who was involved`: **chips inside one field** (24px, a rule border, `Name ×`, no avatar marks, × on every chip), then an inline input `Add people, companies, deals…`. Suggestions come in a dithered popover with the name and a mono caps kind.
   - The second commit button becomes a checkbox `Write it up next`, which feeds `writeUp`.
   - The note `lands in n ledgers` goes.
   - The foot reads `Log call` or `Log meeting`.
2. **New company, person, deal and custom record** (`create-company-dialog.tsx`, and the create dialogs in `people.tsx`, `deals.tsx` and `o.$objectSlug.tsx`), at size M:
   - **Company:** `Name` and `Domain` (a mono value), then a pine `More fields ›` that reveals the rest of the registry fields and the template picker in place.
   - **Person:** `Name` and `Email`. On email blur, **server** `findByIdentity` resolves the domain to a company through the `@spaces/sdk/identity` normalizer; a match is set and shown under More fields.
   - **Deal:** `Company` and `Stage`. The name defaults to `<Company> — <Stage label>` and stays editable.
   - **Dates default to today. Focus lands in the first field.**
   - **Identity match (D7):** a destructive line `<Name> already has this domain` (or `this email`) with an underlined `Open <Name>`. Create is refused in the UI; the server's attach-on-match stays.
3. **Bulk enrich:** done in `port-L2`.
4. **Move space** (S, `space-move-dialog.tsx`):
   - A tree list in a rule box: `Top level`, then `Proptech` with `Now here`, then an indented `Leasing`. The picked row is on bone.
   - The `under X` note and the key go.
5. **Upload** (M, `upload-dialog.tsx`):
   - No head description.
   - A `File against` Segmented `Unfiled · A record · A space`.
   - **Rows:** a Twinkle with `Reading text`, then `✓ Filed`, with sub-rows `Newer version of [<name> ⌄]` / `Replaces <name>`.
   - A `rule`-dashed dropzone `Drop files, or click`, with mono `Files on <record>`. Then `Or paste a link`.
   - The foot note reads `Stays on this server · up to 250 MB`, with Cancel only.
6. **Link folder** (`files/link-folder-dialog.tsx`):
   - The `Map subfolders` hint moves to a tooltip.
   - The `Keep` Segmented is bounded, not full width.
   - The note reads `Read-only · files under this folder`.
7. **Storage picker:** the head is `Attach from Drive` with the mono account. The note reads `Copied onto <record> · shared with the workspace`. The primary reads `Attach n`.
8. **Newer version:** dates go through `formatDay`.

**Acceptance criteria**

- [ ] The Log interaction chip field adds and removes chips; `Write it up next` opens the write-up.
- [ ] New company opens with 2 fields; New person infers the company (test); New deal composes its name (test); an identity match refuses (test).
- [ ] No window foot carries a second commit.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-W2` · afk · L — Email, compose, meeting and file viewer windows

**Blocked by:** `port-W1`.

**What to build.**

1. **Email viewer** (L, `email-dialog.tsx`, `lib/server/emails.ts`):
   - **Head:** the subject, then mono `3 messages`.
   - **Privacy line:** a label chip from the classify labels, then a sans `Visible to you` with an underlined `Widen…`. Variants:
     - `Visible to you, Kavya Iyer  Widen…`;
     - `Visible to the workspace · all your email with <record>  Change…`;
     - forwarded mail: no control.
   - **Thread:**
     - Earlier messages are one line each: name (`To <name>` when sent, H2), a graphite preview, a paperclip count and `13 Oct, 18:40`.
     - With more than 2 earlier messages, the oldest fold into `n earlier messages`.
     - **Server:** `getEmail` returns the siblings by `thread_id` through `canRead`.
   - **Latest message, open:**
     - the sender with mono email and `10:42` on the right;
     - lanes `To` / `Cc` / `Via`, sans 12 graphite. There is no From lane; it appears only in the private state.
   - The body sits in a rule box, with mono `1 remote image not loaded` under it. The `Message` label head goes.
   - **Attachments:** a `LabelHead` `ATTACHMENTS · n`, rows with lane `4.2 MB · <uploader> · 13 Oct`, and a hover row `···` with `Open · Download · File on… · Newer version of…`. The row itself opens the viewer, stacked.
   - **Widen window** (S, "Who can read this"):
     - the owner row with `Owner`, then granted rows with `×`;
     - `Add a person…`;
     - the checkbox `Every email I have with <record>`;
     - the note `Subject, people and date stay visible to all`, then `Widen`.
   - **States:**
     - Loading: the head from the row, and a centred Twinkle.
     - Private: `From`/`To`, and a bone panel `Private to <owner>'s mailbox`.
2. **Compose** (`email/draft-composer.tsx`, `compose-windows.tsx` → size L):
   - **Mode:** a Segmented `Reply · Reply all · Forward`, with mono `Saved 10:51` or `Saving…` on its right.
   - **Recipients:** sans `Cc` and `Bcc` toggles; an alias chip `<name> <email> ⌄`; a dashed chip for a new address.
   - **Quoted parent:** `<name> wrote at 10:42 · Show`.
   - **Attachment chips:** a glyph and a mono size; `From original` on a forward; a dashed `+ Attach · or a file from <record>`.
   - **Tool row above the foot:** `Template` · `Variable` (a new path picker that inserts a `{{path}}` chip from the shared grammar) · `···` (`Delete draft…`).
   - **Foot:** `Send`, or `Review and send` when variables are present. Trash, the recipient count and the keys go.
   - **Review window:**
     - a left pane, 200px, bone, listing recipients (a flagged row has a warning square and a count);
     - a right pane with the rendered copy: a resolved variable on a `bg-selected` chip, a blank as an amber chip, and a fill row `name.first · For this copy only… · Leave blank`;
     - the note `Can't be unsent · goes at once`, then `Back to draft`. `Send` appears once nothing is open.
   - **States:**
     - Sending: the draft greys, the note shows a Twinkle and `Through your Gmail`, Cancel is disabled.
     - Failed: `■ Not sent · Gmail asks you to sign in again · the draft is kept`, and the primary becomes `Reconnect Gmail`.
   - **Offline** (local draft persistence) is listed in the close comment and not built.
3. **Meeting window** (L, `meeting-dialog.tsx`):
   - **Head:** the title and mono `11 Oct · 15:00–15:45`. An upcoming meeting shows sans `Join call ›` on the right.
   - **`PARTICIPANTS`:** `Open in Google ›`, and rows with `✓ Accepted` / `? Maybe`.
   - **`LINKED RECORDS`:** `+ Pin a record…`.
   - **`WRITE-UP Via Granola · Anish · 16:02`:** `Open in Granola ›`, the **write-up text inline in serif 17** (**server:** return the note body), and extra shared notes as bordered rows. Empty, it is `Write-up +`.
   - **`ACTION ITEMS n in Review`:** task suggestions with their due date, `Add task` and `Skip`.
   - **`PRIVATE TO YOU`:** transcript and typed notes; absent when empty.
   - **Prep:** shown only before the start. The result shows the model line. The foot note reads `Not kept unless saved`, then `Save as note`.
4. **File viewer** (viewer size, `document-preview.tsx`, `files/viewer-sidebar.tsx`):
   - **Head:** the kind in sentence case (`Deck · 4.2 MB · 14 pages`), `Download` without an icon, and the caption `Page 5 of 14` under the page.
   - **`VERSIONS`:** walks the replace chain, newest first, through `formatDay`.
   - **`SOURCE`:** the originating email as a link that opens it, `Via <Provider> · <uploader> · <day>`, and `Sha 3f9c…a21e · stays on this server`.
   - **A followed file:** the head reads `Sheet · Drive · rev 4 · following`.

**Acceptance criteria**

- [ ] Thread siblings render and are read-checked (test).
- [ ] The compose foot has no Trash and no keys; Review renders per recipient.
- [ ] The meeting write-up is inline; Prep is hidden after the start.
- [ ] Viewer versions walk the chain (test).
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-K1` · afk · M — Cmd-K at one fixed size

**Blocked by:** `port-4`.

**What to build.** Files: `components/command-palette.tsx`, `palette-preview.tsx`, `ui/command.tsx`, `lib/file-in-space.ts`, `lib/search/preview.ts`, and the search passage meta.

1. **Window.**
   - Size: `width: min(1060px, 100vw − 2rem)`, `height: min(560px, 100dvh − 4rem)`. Paper, 1px hairline, a solid `3px 3px 0` ink shadow.
   - A flex column: input 52 / body `flex-1 min-h-0` / foot 32.
   - The body is the list (`flex-1 min-w-0 overflow-y-auto`) plus the pane (`basis-[40%] max-w-[420px] min-w-[280px]`, bone, always mounted; blank when nothing is previewable, D10).
   - **Every state (empty, typing, step, no results, loading) renders inside the same box.**
   - Delete the `has-[[data-preview]]` widening and both `max-h-[420px]`.
2. **Input:**
   - 52px on bone with a hairline under it.
   - A `FIND` stamp; the query in `text-title`.
   - The aside, mono micro: `On <scope>`.
   - The placeholder reads `Find a record, a page, an action`.
3. **Groups:** the head is 28px bone with a rule under it, in mono caps graphite with the count on the right: `JUMP TO`, `ACTIONS`, `RECORDS`, `PASSAGES`. With nothing typed on a record, the head reads `ACTIONS n` only.
4. **Rows:**
   - `h-row`, a 16px glyph slot. The highlighted row is bone with a `font-medium` name. Actions use a mono `›` glyph.
   - **Lanes:**
     - jump: the key only;
     - a saved view: its object's plural;
     - a company: its first space path;
     - a deal: its stage label;
     - a passage: `<title> · <day>` for a note, `<name> · p.N` for a file.
   - Passages are set in serif, clamped to one line.
   - The inline snippet column goes.
   - Loading: `Still looking` with a Twinkle in the group head.
5. **No results:** `Nothing found`, plus an actionable row `Ask "<query>"` with lane `Tab`. The foot then drops `Tab Ask`.
6. **Step mode (File in):**
   - An outline stamp `FILE IN ›`; rows `✓ <path>` with `Filed here`; a bare count; `· n subspaces` where there are children.
   - When nothing matches exactly: `+ New space "<query>"` with lane `Under <closest root>`.
   - The foot reads `↑↓ Move · ⌫ Back to find`.
7. **Pane:**
   - **Record:** the stamp, then glyph and name in serif `text-page`; a company's domain in mono; the double rule; the readouts two-up (only those with a value); then the attribute grid (112px bone label, sentence case; mono money; stage badge); then the actions foot (26px outline, `Open`, `Move stage…`).
   - **Object:** glyph, serif name, double rule, rows `All 28` (**server:** total count) and the saved views, then `Open <plural>`.
   - **Passage:** `<file>` in mono with `Page N of M`, the context, the match in a serif box, `On <record> · <day>` (**server:** day and parent), and `Open at p.N`.
8. **Foot**, sentence case: `↑↓ Move · ↵ Open`, plus `· → Actions` when the pane has actions, and `Tab Ask` once something is typed. A file passage reads `↵ Open at p.N`.

**Acceptance criteria**

- [ ] The window size is constant across all states (a render test asserts the style).
- [ ] The no-results Ask row works.
- [ ] Step mode can create a space.
- [ ] The object pane shows the All count.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-K2` · afk · M — Ask: chips in the composer, /ask, answer states, citation hover

**Blocked by:** `port-K1` (it owns Twinkle usage in the palette; the files are otherwise disjoint).

**What to build.** Files: `components/ask/{ask-dock,ask-thread,ask-answer,ask-card,find-table,save-as-watch,mention-popover}.tsx`, `routes/_app/ask.tsx`, `lib/ask/{thread-list,cards}.ts`, and `lib/server/ask.ts` with the barrel.

1. **Dock:**
   - The head is 48px bone: the thread title, `+` and `×`. **No chips in the head.**
   - **Composer:** one bordered box. Chips sit inside it: 22px, `Exponent ×`, `Web · Exa ×` (on bone). The × carries the tooltip `Ask beyond <name>` or `Leave the web out`. With no chips, nothing prints. Then the field, with `⌘↵` in its end lane. **No Send button.**
   - Under the box: `Save as note`, which stays put and swaps to `Saved as note` (D13), and `Open in /ask ›`.
   - While dragging the edge, a width tag shows (360–560).
2. **`/ask`:**
   - The nav is 280; its head is 48 with `Threads`, `New` and `«`.
   - Day bands are 28px bone mono caps (`TODAY`, `14 OCT`).
   - Rows are `8/12` padding; the current row is bone with a medium title. The subline is sentence case (`Saved as note`, `n applied`).
   - The thread head is 48px with `Open beside <record>` and no chips.
   - The scope divider reads `Scope now <words> · 10:51`.
   - **Find table:**
     - fixed widths;
     - `Found on` as mono `yourstory.com +1`;
     - `Via` in plain mono;
     - states in sentence case: `Filed`, `Dismissed`, `Added`, `Enriching` with a Twinkle, `Enriched`, `Enrichment failed`;
     - the line above it: the route and timing on the left, `Save as watch ›` on the right; once saved, a centred divider `Saved as a watch on <space> ›`.
3. **Answer states:**
   - **Thinking:** a Twinkle, `Reading n sources` (the sum of found so far), then `Computing`.
   - **Stop** moves into the live turn as an outline button, right-aligned.
   - **Call words** in sentence case: `Running`, `Refused`, `Failed`, `Unmounted`.
   - **A `Notice` row** (bone, rule border, a 6px warning or destructive square, a sentence and one link):
     - sensitive: `Sensitive space in scope · answered on the local model`;
     - cap: `Daily AI cap reached · 200 of 200 runs · resets 00:00`, with `Usage ›`;
     - refused: `Sensitive space · nothing sent`, with `Add a local model ›`.
     - Map them from the turn's route and `CapExceeded` fields.
   - **No model:** `Ask needs a model to answer.` with an ink `Add a model ›`.
   - **Stopped:** `Stopped · 2 of 3 calls`.
   - Number columns in answer tables are mono and right-aligned.
4. **Cards:**
   - The proposed state has a dashed border.
   - Outcomes: `Applied · in Tasks`, `Applied · by you, in History`, `Skipped`; a conflict reads `Not applied · <actor> moved it on <day>` (**server:** the actor and day from `attribute_event`).
   - `Waiting in Review ›`.
   - Applying: `Applying…` with Skip disabled.
   - **Undo** comes through `port-B1`'s hold.
5. **Citation hover:**
   - **Server:** a new `previewAskRef({ ref })`.
     - It parses with `parseRef`.
     - `doc:<id>#idx` returns the chunk text, page and page count, under the `canReadNoteSql` guard.
     - `note:`/`memo:` return the first chunk; `interaction:` returns the body excerpt; `attr:` returns the value.
     - It also returns the parent name and day. **No migration.**
   - The popover is 340 wide, dithered: a head with the file glyph, mono name and `Page 5 of 14`; the passage in serif 14/21 in a bone box; the foot `On <record> · <day>`. It loads lazily, once per ref.
   - Mention popover rows are 32px with a bone highlight and a sans kind word.

**Acceptance criteria**

- [ ] Chips edit the scope from the composer (test).
- [ ] `previewAskRef` honours read policy (test).
- [ ] Notices render for sensitive, cap and refused.
- [ ] Stop sits in the turn.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-S1` · afk · M — Shell: sidebar foot, workspace menu, keyboard sheet, sign-in copy

**Blocked by:** `port-4`.

**What to build.** Files: `components/app-sidebar.tsx` and its test, `workspace-mark.tsx`, `lib/tasks/due.ts`, `routes/_app.tsx`, `keyboard-help.tsx`, `needs-setup.tsx`, `routes/{login,setup,join}.tsx`, `lib/server/setup.ts`, `routes/_app/settings/members.tsx` (`?invite`), and the e2e specs.

1. **Sidebar:**
   - `Ask ⌘J` moves from under ⌘K to a foot row above the account row, in both states.
   - **Upload leaves the account row.** It stays in ⌘K, on Files and in the first run.
   - **Account row:** 52px, `border-t` hairline, a 24px ink initials square, and the Settings mark alone on the right.
   - **Account menu** (260 wide, no icons): `Signed in as <email>` (mono graphite), a rule, `Drafts n` (D9), `Keyboard` with `?`, `Sign out`.
   - **Collapsed (48):**
     - rows `w-8 h-[30px]`, group rules `w-5`;
     - the foot: Ask (h-10, tooltip `Ask ⌘J`), Settings (h-10, rule top, `Settings G ,`), account (52, hairline top).
   - **Tooltips** read the name, then the key in mono at 85% opacity, using `IconTip`'s new `keys` prop.
   - **Tasks lane:** `8 due` in ink; **destructive only when a task is overdue.** Add `overdueCount` to `lib/tasks/due.ts`.
   - **Nav focus:** the outset reticle (`focus-ring`), not inset.
   - **Monogram:** serif semibold. The head name is `text-body` and truncates.
   - **Phone drawer:** no chord hints and no `⌘K`/`⌘J`; `8 due` stays.
2. **Workspace head menu:**
   - The mark and name become a `DropdownMenuTrigger` (`«` stays separate).
   - The menu is 220 wide: `General`, `Members` with a count (active members, fetched lazily on open), a rule, then `Invite a member…` for admins only (`isAdmin` passed from `_app.tsx`).
   - `members.tsx` gains `validateSearch({ invite })`, which opens `InviteDialog`.
3. **Keyboard sheet:**
   - `Ask ⌘J` is added after Palette.
   - `In a sheet` becomes `In a window`.
   - The foot note goes; the strings follow the Shell board.
   - In NeedsSetup, the link is ink medium, not primary.
4. **Sign-in copy** (no ↵ in any button; the keys went in `port-3`):
   - **Setup step 1:** eyebrow `Setup · 1 of 2`, the blurb `Signup closes for good once this account exists. Everyone else joins by invitation.`, no hints on Setup token or Workspace name, the password hint `At least 12 characters`, and the foot `Self-hosted · nothing here leaves this server`.
   - **Setup step 2:** the blurb `A worked example in data-center cooling: a small space tree, three companies and a memo. General removes it in one step.`; `Load demo data` (outline, left) and `Start empty` (primary, right), equal widths, no foot.
   - **After the admin exists:** `/setup` redirects to `/login?from=setup`, which shows `<workspace> is set up. Everyone else joins by invitation.` (`getSetupState` returns the name).
   - **`/join`:**
     - no blurb on the valid form;
     - the email field locked on bone with no hint;
     - the invalid state reads `This invitation isn't valid` / `Each link works once. Ask whoever invited you for a new one.`.

**Acceptance criteria**

- [ ] A sidebar test covers Ask at the foot, no Upload, Tasks red only when overdue, and the drawer without hints.
- [ ] The workspace menu opens; Invite shows for admins only.
- [ ] The e2e first-run and login specs pass with the new strings and button order.
- [ ] Gates: typecheck, test, lint, prettier; web build; `pnpm e2e`.

---

#### `port-St1` · afk · M — Settings look pass

**Blocked by:** `port-4`. It must land before `port-B3` (both touch `settings-nav.tsx`).

**What to build.**

1. **Nav** (`settings-nav.tsx`):
   - **Group heads are ruled bands:** 36px, `items-end`, `pb-[6px] px-[10px]`, a 1px hairline under, mono 11/16 `tracking-label` caps, weight 500, foreground. The 36px carries the gap between groups, so the old `mt-5` goes.
   - The row stack is `p-3 gap-[2px]`.
   - The current row's border is `border-hairline` (ink).
   - **For a member:** an admin row's label is graphite and its right lane reads mono `Admin` instead of a count. It stays a link.
2. **API tokens** (`routes/_app/settings/tokens.tsx`):
   - The inline form goes. `New token` becomes the head action (one outline 32px, D15), opening a window (S): `Name`, then `It may` with the line `It acts as you, never more.`, three checkboxes each with its mono scope, then `Cancel` · `Create token`.
   - After creating, a panel reads `Copy it now. Spaces shows it once.`, with `Copy` and `Copy command`.
   - Empty is the EmptyRow `Tokens +`.
   - The ledger heads: `Name · It may · Created · Last used`. A revoked row is struck through and reads `Revoked 20 Sep`.
3. **Models** (`routes/_app/settings/models.tsx`):
   - `Treat every record as` becomes a Segmented `Normal | Sensitive`.
   - Lane ids move into a tooltip.
   - **With no provider:** the routing grid collapses to the single row `Who does what · Set up a provider ›`.
4. **Plugins** (`integrations/registry-pane.tsx`): the Available filter becomes a Segmented with counts (not `Tabs`).
5. **Every settings page head:** one outline 32px action at most. Re-check the per-object page (`New relationship` + `New attribute` + `···` becomes `New attribute` + `···`, with `New relationship…` in the `···`).
6. **Objects and templates:** a row click opens Edit; the rules lane prints `filter` and `sort` only when set.
7. **Settings ledger column heads** (`Person`, `Role`, and the other settings ledgers' lane heads) become sans 12 graphite in sentence case, like the list table's heads. They still print in mono.
8. **Accounts:**
   - Sync readouts read `In sync · 9 Oct` (dates were done in `port-2`; check the strings).
   - The Testing-mode sentence on the account page goes; it moves into `port-B3`'s Set up tab.

**Acceptance criteria**

- [ ] A nav render test covers the band heads, the ink current row and the member `Admin` lane.
- [ ] The token window flow is tested.
- [ ] The Models empty state collapses.
- [ ] No settings head carries more than one action besides `···`.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-B1` · afk · M — Undo by holding the write

**Blocked by:** `port-4` (toast action and drain line).

**What to build.** This is a **client-side delayed commit with no migration.** A server pending state was rejected: it needs a `held` status, every reader of `status='open'` would have to change, and accept fans out into writes that have no undo executor.

1. **`apps/web/src/lib/held-decisions.ts`:**
   - A store keyed by suggestion, candidate or card id. Each entry is `{ verb, commit: () => Promise, label, at }`, exposed through `useSyncExternalStore`. `HOLD_MS = 5_000` (D6).
   - **Deciding:** the row is hidden (Today, Review and Ask filter held ids out), and a toast with `duration: HOLD_MS` shows `Undo` and the drain line.
   - **Undo:** clears the timer and the row comes back where it was.
   - **On expiry** the server fn runs:
     - success → `router.invalidate()`;
     - failure → the row comes back with the error toast;
     - "already decided" → a silent invalidate.
2. **Writes held:** `acceptSuggestion`, `rejectSuggestion` (shown as Dismiss), `acceptSuggestionColumn`, `dismissDuplicate`, `applyAskCard`, `skipAskCard`.
   - **Not held:** `mergeDuplicate` (confirmed in Compare), task Done (it already has a compensating Undo), Write and Prep.
   - In an Ask thread the card shows its outcome optimistically during the hold, and Undo returns it to Open.
3. **Lifetime:**
   - The store and the Toaster live under `routes/_app.tsx`, so in-app navigation neither cancels nor commits early.
   - A `pagehide` listener, installed once, flushes every held entry with `navigator.sendBeacon` to a new same-origin POST route (`routes/api/held-decisions.ts`, `requireUser`, running the same programs). Sign-out flushes first.
4. **Adopt it** in `components/inbox/suggestion-card.tsx` (Review), `components/ask/ask-card.tsx` and `port-T2`'s rows.

**Acceptance criteria**

- [ ] Unit tests: undo within 5s means no server call; expiry means one call; failure brings the row back.
- [ ] The beacon route runs the decision for an authenticated user and refuses an anonymous one.
- [ ] Gates: typecheck, test, lint, prettier; web build.

---

#### `port-B2` · afk · S — Admin-issued password reset link

**Blocked by:** `port-S1` (both edit `members.tsx`).

**What to build.** **No migration.** better-auth 1.6.25 already consumes `reset-password:<token>` verification rows. Self-serve reset stays impossible because `sendResetPassword` stays unset.

1. **`lib/auth.ts`:**
   - Add `emailAndPassword.revokeSessionsOnPasswordReset: true`.
   - Add `verification.storeIdentifier: { default: 'plain', overrides: { 'reset-password': 'hashed' } }`, so only the hash is stored, as with invites.
2. **`lib/server/members.ts`:**
   - `createResetLink({ userId })`:
     - requires `requireAdmin()`;
     - refuses: self, a banned user, a user with no credential account;
     - deletes that user's earlier `reset-password:*` rows;
     - mints `randomBytes(24)` base64url and writes the verification value with a **24h expiry**;
     - returns `{ url: APP_URL/reset?token=… }`, shown once.
   - A public `getResetPreview({ token })`.
   - Re-export both through the barrel (server-fn bodies only).
3. **`routes/reset.tsx`** (public; a session present redirects to `/today`):
   - Eyebrow `Password reset`, title `Set a new password`.
   - `New password` with the hint `At least 12 characters`, then `Again`.
   - `Set password`, with the foot `This link works once.`
   - Mismatch: `The two passwords differ.`
   - Success → `/login` with the blurb `Password set. Sign in with it.`
   - Invalid → `This link isn't valid` / `Each link works once. Ask an admin for a new one.`
   - Run `pnpm generate-routes`.
4. **Members** (`settings/members.tsx`):
   - The row `···` gains `Send a reset link…` (admin only; not on yourself, not on a suspended member). It opens a window like Invite's second state: the link box with `Copy link`, the note `One use · 24 hours`, and `Done`.
5. **`/login`:** after a credential error (not a 429), the foot becomes `Forgot it? An admin can send you a reset link.`

**Acceptance criteria**

- [ ] Integration test: issue a link, reset, the old sessions are revoked, and the link fails a second time.
- [ ] Self and banned users are refused.
- [ ] Gates: typecheck, test, lint, prettier; web build; `pnpm e2e`.

---

#### `port-B3` · hitl · L — Connections: providers as bundled capabilities, Set up and In use

**Blocked by:** `port-St1`, and the owner's answer on bundling.

**Decision needed first.** Gmail, Google Calendar, Google Drive and Box become **bundled capabilities**: signed plugin code shipped in the image, always installed, never uninstallable, enabled per use from the provider page. The alternative is folding them into core. The recommendation is bundled plugins, because they keep the SDK seam and `source_ref` provenance. Record it as an amendment to D51 (or as D82), with D81 updated.

**What to build** (no migration; choices go in `workspace.settings` jsonb, `providers.google = { audience, consent }`):

1. **Routes:**
   - `routes/_app/settings/connections.tsx` becomes the Connections list.
     - The head is `PROVIDERS 1 of 2 set up`.
     - Rows are 44px: a 20px icon slot, the name (13 medium), a 260px mono status, and a 72px link.
     - `Google · Set up · 4 of 6 members connected · Open ›`; `Box · Not set up · Set up ›` (ink); `Microsoft · Not available yet` (graphite, no link).
     - Other row states: `Testing · reconnects weekly`; `Google said: invalid_client` (destructive) with `Fix ›`.
   - A new `connections_.$provider.tsx` with `validateSearch({ tab: 'setup' | 'in-use' })`. It opens on `in-use` once the client is active, `setup` otherwise; an unknown provider gives `notFound`.
   - `connection-apps.tsx` becomes a 301 through `toConnections` in `lib/settings-moves.ts`.
   - `/settings/plugins/<bundled id>` redirects to the provider page's In use tab.
   - Run `pnpm generate-routes`.
2. **Nav:** Integrations = Connections (first, admin) · Plugins · Enrichment · Email forwarding.
3. **The Set up tab** (Kit `Tabs` `Set up | In use`):
   - **A question row:** `Your accounts are on`, with a Segmented `Google Workspace | Personal Gmail`, and the copy under it:
     - Workspace: "A company domain on Google Workspace. Members connect once and stay connected."
     - Personal: "Google keeps an unverified app in Testing: each member reconnects every 7 days, forever. Verification needs a paid security review per app." Then "Email only? Forwarding needs no Google app." with `Email forwarding ›`.
   - **Numbered steps:**
     1. Create a Google Cloud project · `Open Google Cloud ↗`
     2. Turn on the Gmail, Calendar and Drive APIs · `Open the API library ↗`
     3. Consent screen · a Segmented `Internal | External`, preselected from the audience, with its hint
     4. Redirect address · **the code's path `/api/connections/google/callback`**, with `Copy`
     5. OAuth client · Client ID and Client secret, through the Save bar
     6. Test · `Connect my account to test` (consents to the first ticked use), then `■ Works · <email>`
   - `connection-apps-section.tsx`'s `RedirectRow` and `OAuthClientGroup` move here as `ProviderSetup`, and the old file is deleted.
4. **The In use tab:**
   - **`MEMBERS MAY USE`:**
     - Rows: a checkbox (`integration.enabled`), the use, mono `4 people · last sync 3 min`, health `■ 0 failed · 7 days` or `■ 1 failed · Ines`, and `Runs ›` (→ Usage filtered to the integration).
     - An unticked use reads `Off for this workspace`. Unticking stops its syncs and keeps the rows.
   - **`CONNECTED 4 of 6`:** member, email, uses, `■ In sync` / `■ Token expired`.
5. **Bundling:**
   - Boot ensures one `integration` row per bundled capability (`packages/core/src/writes/boot.ts`, beside `firstBootPlugins`, from tarballs in the image).
   - A `BUNDLED_PLUGINS` constant, derived from `PRODUCTS`, hides them from the Plugins ledger, the catalogue, the nav count and Uninstall.
6. **Offers** (`lib/connections/accounts.ts` `offerFor`):
   - Drop the `install` branch.
   - The outcomes: `connect`; `configure` (admin, → the provider page); `ask` (member); `unavailable`.
   - Update the copy in `start.ts` and `callback.ts`, and the `google` item in `lib/setup/whats-set-up.ts`.
7. **Today lines** (`lib/today/attention.ts`, notices):
   - `Bring in your email and meetings · Connect Google ›`, for a member with nothing connected once Google is set up.
   - `Google expires in 2 days · personal Gmail reconnects weekly · Reconnect ›`, from `refresh_token_expires_at` within 48h.
   - The broken line's fix goes to the provider page.

**Acceptance criteria**

- [ ] The decision amendment is written.
- [ ] The routes redirect (tests).
- [ ] Bundled rows exist after boot and never show in Plugins.
- [ ] `offerFor` table test.
- [ ] Both Today lines are tested.
- [ ] Gates: typecheck, test, lint, prettier; web build; `boot.ts` against an empty database.

---

#### `port-B4` · hitl · M · migration — Archive any record

**Blocked by:** `port-R1`, and the owner's yes. **Migration: one at a time across sessions.**

**Decision needed first.** A4 puts `Archive` in every record's `···`, and the Lists row `···` carries it too, but only spaces can be archived today. Should every record get archive and restore (recommended), or does Archive stay space-only and leave the menus?

**What to build** (if yes):

1. A migration adding `entity.archived_at` and `entity.archived_by` (an FK to `user`; add it to `ENTITY_REFS` if it references an entity, which it does not). Run `pnpm db:generate --name entity_archive`.
2. Server fns `archiveRecord` and `restoreRecord`.
3. Exclude archived records from:
   - every list read and the view SQL;
   - Cmd-K and the search lanes;
   - the context assembler walk;
   - Today.
4. A record's own page still opens, showing:
   - an outlined stamp `ARCHIVED`;
   - a graphite title;
   - `···` only;
   - the notices line `■ Archived 12 Oct by <name>` with `Restore ›`.
5. Add `Archive` to the record `···` (`port-R1`) and the list row `···` (`port-L2`).

**Acceptance criteria**

- [ ] Archive and restore round-trip (integration test).
- [ ] An archived record is absent from lists, search and context, and present on its own page.
- [ ] Gates: typecheck, test, lint, prettier; web build; boot against an empty database.

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
