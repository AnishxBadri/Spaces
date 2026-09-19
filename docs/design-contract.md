# The design contract

Instrument is the design of Spaces. `DESIGN.md` describes it — what the system is and
why every part of it is that way. This file is the other half: what an agent does
before it builds a surface. Read this; open `DESIGN.md` only for the section a line
here sends you to.

`DESIGN.md` is the source. Nothing below invents language it does not already carry;
every statement traces to a `DESIGN.md` section or to a file that shipped. Where the
two disagree, `DESIGN.md` is right and this file is a bug — fix it here, not there.

Four parts: the vocabulary you may spell, the primitives that already exist, the
precedent every new surface copies, and the line between what lint enforces and what a
reviewer judges.

---

## 1. The vocabulary

### Materials (`DESIGN.md` §2)

Two untinted neutrals, one ink, one LED. Every value is live in
`apps/web/src/styles.css`; that file decides, this table names.

| token       | class                       | role                                                                                              |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `paper`     | `bg-paper`                  | the data field — tables, records, dialogs                                                         |
| `bone`      | `bg-bone`                   | the chassis — sidebar, rails, dialog feet                                                         |
| `bone-deep` | `bg-bone-deep`              | pressed, disabled, archived rows (an archived option badge is struck on plain bone — see `Badge`) |
| `rule`      | `border-rule`               | inner rules — rows, cells, inputs                                                                 |
| `hairline`  | `border-hairline`           | 1px structure — sections, sheets, the edge                                                        |
| `graphite`  | `text-graphite`             | the second text colour, and the only one                                                          |
| `ink`       | `text-foreground`           | text                                                                                              |
| `pine`      | `bg-primary`/`text-primary` | the LED — primary action, active tab, end-dots                                                    |
| wash        | `bg-selected`               | the selection tint                                                                                |

Semantic colour only where it encodes state: `text-destructive`, `text-warning`,
`text-success`, `text-info`. A readout is coloured only when its value is nonzero and
bad; a zero reads graphite.

**Material and scale** (`DESIGN.md` §4). Radius is `rounded-md` (2px) on controls and
inputs, `rounded-none` everywhere else — no 4, 6, 8 or 12, no pills, no circles.
Shadows are hard offsets: popover `shadow-[2px_2px_0_0_var(--hairline)]`, dialog
`shadow-[3px_3px_0_0_var(--hairline)]`. Nothing blurs. Spacing is 4 8 12 16 24 32 and
the page gutter is 32 (`px-8`). Heights: row 36 (`h-row`), control 32, small 26, badge
20, nav row 30, readout strip 56–64, dialog head 44, dialog foot 52.

### The named type steps (`DESIGN.md` §3)

Eight steps, fixed rem, never fluid. The list is the `--text-*` custom properties in
`apps/web/src/styles.css` and the `NAMED_STEPS` table in `eslint-rules/vocabulary.js`,
which a test keeps in sync.

| step      | size / leading | role                                |
| --------- | -------------- | ----------------------------------- |
| `field`   | 10 / 12        | labels inside cells and readouts    |
| `micro`   | 11 / 16        | timestamps, chip counts, key hints  |
| `label`   | 12 / 16        | field labels, metadata              |
| `ui`      | 13 / 20        | the table and form workhorse        |
| `body`    | 14 / 20        | running text in UI, composer inputs |
| `title`   | 15 / 22        | a name inside a readout cell        |
| `page`    | 22 / 28        | page titles                         |
| `display` | 26 / 32        | record names                        |

**An unnamed size does not ship.** `text-[…]` and `leading-[…]` are rejected by
`instrument/vocabulary`, which names the nearest step in the message; the only way
onto the list is `apps/web/src/styles.css`. A genuine optical one-off (initials inside
a 16–22px square) takes an inline comment saying why plus a scoped disable.

Utilities that carry a step whole: `title-serif`, `label-caps`, `field-label`, `mono`,
`numeric` (tabular + right-aligned in one class), `tabular`.

### The three voices (`DESIGN.md` §3)

**Serif** where a human wrote it · **sans** for the interface · **mono** for everything
the instrument measured.

- **Serif** — page titles, record names, dialog titles, settings section heads, empty-state
  sentences, note bodies, theses, reasons.
- **Sans** — rows, forms, buttons, every running sentence. `text-ui` is the workhorse.
- **Mono** — money, counts, dates, durations, IDs, domains, column labels, key hints.
  Comparable figures take `numeric`.

Never a name or a sentence in mono, never a number in sans — with one shipped
exception: the fixed mono lanes a ledger row or a board card **ends** on are the
instrument's filing stamp, not prose, and a record or person name printed there is mono
graphite (`DESIGN.md` §5 P2's `LedgerFigure` and P4's `company · check`;
`apps/web/src/routes/_app/today.tsx:348`, `apps/web/src/components/deal-board.tsx:267`).

### The Casing Rule — three tiers (`DESIGN.md` §3)

The tier is decided by who is speaking, never by how small the text is.

- **CAPS** (`label-caps`, `field-label`) — structure the instrument labels: section
  heads, column heads, tabs, field labels.
- **Sentence case** — anything a person reads or clicks. Every control, button, chip,
  menu item and empty-state invitation. `Add task`, `Due date`, `Keep open`.
- **lowercase mono** — only what the instrument prints about _itself_: key hints
  (`↵ add · ⇧↵ add & keep open`), units, `end`, `dateless is legal`, `board ›`.

---

## 2. The primitives that exist

Compose these. A new component is a last resort and needs the same argument a modal
needs.

| primitive                                                                         | file                                                    | for                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `PageHeader`, `KeyHint`, `ReadoutStrip`                                           | `apps/web/src/components/page-header.tsx`               | P1 — serif title or sentence, mono eyebrow/readout, actions right, hairline under       |
| `LedgerSection`, `LedgerRow`, `LedgerFigure`, `ReferenceBar`                      | `apps/web/src/components/ledger-section.tsx`            | P2/P3 — caps label + mono count, 36px rows on rules, a fixed mono lane, value-vs-median |
| `RecordHeader`, `RecordBody`, `RecordSection`, `PropertyGrid`, `PropertyCell`     | `apps/web/src/components/record/record-parts.tsx`       | P7 — the record anatomy: crumb, readouts, property grid, sections                       |
| `RailSection`, `RailRow`, `RailItem`, `RailEmpty`, `StageStepper`                 | `apps/web/src/components/record/record-parts.tsx`       | the bone rail right of a record                                                         |
| `InitialsMark`, `DitherMark`, `initialsOf`                                        | `apps/web/src/components/record/record-parts.tsx`       | ink initials squares and 1-bit fallback marks                                           |
| `RecordTable`, `TableToolbar`, `AddColumnButton`                                  | `apps/web/src/components/table/record-table.tsx`        | the signature grid — sticky head, 36px rows, columns popover, `N OF M` foot             |
| `useTablePrefs`                                                                   | `apps/web/src/components/table/use-table-prefs.ts`      | per-surface column order / visibility / width, under a frozen key                       |
| `RecordLinkCell`, `IconBadge`, `InitialBadge`, `ChipLink`, `MetaCell`, `DateCell` | `apps/web/src/components/table/cells.tsx`               | the cell renderers a hand-declared column uses                                          |
| `ViewBar`, `useViewState`                                                         | `apps/web/src/components/views/`                        | saved views — **object surfaces only** (`/companies`, `/deals`, `/people`, `/o/$slug`)  |
| `SettingsSection`, `SettingsRow`                                                  | `apps/web/src/components/settings/settings-section.tsx` | a section of the settings shell — serif title, sans sentence, mono crumb, 48px rows     |
| `SettingsNav`, `SETTINGS_SECTIONS`                                                | `apps/web/src/components/settings/settings-nav.tsx`     | the settings nav grammar — one row per section, groups derived, `admin` in the lane     |
| `EmptyState`                                                                      | `apps/web/src/components/empty-state.tsx`               | P5 — dither block, serif sentence, one sans line, the primary with its key              |
| `DitherBlock`, `DensityRamp`                                                      | `apps/web/src/components/dither.tsx`                    | the only texture; loading is a density ramp, never a shimmer                            |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogFooter`, …                      | `apps/web/src/components/ui/dialog.tsx`                 | P8 — 44px serif head + mono context + `esc`, 20px body, 52px bone foot                  |
| `useConfirm`, `ConfirmDialog`                                                     | `apps/web/src/components/ui/confirm-dialog.tsx`         | the destructive confirm; it replaces `window.confirm` everywhere                        |
| `Button`, `Input`, `Label`, `Popover`, `Tooltip`, `DropdownMenu`                  | `apps/web/src/components/ui/`                           | the atoms — reticle focus, 2px radius, key hints inside                                 |
| `Badge`, `badgeClasses`, `badgeTint`                                              | `apps/web/src/components/ui/badge.tsx`                  | the square option badge — takes the option row + index, `archived` and `unselected`     |
| `Checkbox`, `checkboxClasses`                                                     | `apps/web/src/components/ui/checkbox.tsx`               | the 14px square that fills with pine; a button, never a native control                  |
| `Switch`, `switchClasses`                                                         | `apps/web/src/components/ui/switch.tsx`                 | the 24×14 square track — graphite knob off, pine knob on, legible from one switch       |

---

## 3. The precedent map

Every pending surface is one of five shapes. The shape decides the pattern; copy the
named file rather than designing. Name the pattern you copied in the PR description.

**A shelf** — a list of things with no object row behind them (`/documents`, Usage).
→ **`/portfolio`**, `apps/web/src/routes/_app/portfolio.tsx`. Hand-declared
`createColumnHelper` columns (`:54`), `RecordTable` + `TableToolbar` (`:230`),
`useTablePrefs` under a frozen key, `EmptyState` at zero. **No attribute registry and
no `ViewBar`** — saved views address objects, and a shelf is not one.

**A queue** — pairs or suggestions a human decides one at a time (`/inbox`, the
suggestion queue). → **`/dedupe`**, `apps/web/src/routes/_app/dedupe.tsx`. `PageHeader`
whose description is a mono count line, a `max-w-220` column of cards, each card
carrying its own accept/dismiss with a toast, `EmptyState` at zero. Not a table: a queue
row is a decision, not a cell.

**A settings section** — Integrations, Connections, Providers, Routing.
→ **the FX ledger**, `apps/web/src/routes/_app/settings/currency.tsx`, built from
`SettingsSection` and `SettingsRow`
(`apps/web/src/components/settings/settings-section.tsx`). Serif title, one sans
sentence, a mono `SETTINGS / …` crumb right, hairline under; 48px rows on rules with
the control right. A ledger inside the section takes a `field-label` head on
`border-y-hairline` with lanes shared by head and rows, and its foot says what the
model does.

**A settings section is a child route under the settings shell** (SPA-26). `/settings`
is a layout — `apps/web/src/routes/_app/settings.tsx` — and every section is one file
under `apps/web/src/routes/_app/settings/` plus one row in `SETTINGS_SECTIONS`
(`apps/web/src/components/settings/settings-nav.tsx`). Never a section appended to
another section's file, and never a page of its own outside the shell: the eleven
pending sections (Providers, Routing, Usage, Integrations, the manifest form, install,
OAuth, Connections, Binding health, and the two embeddings slices) all take this one
answer. The row carries the path, the label, the `group` it joins — `workspace`,
`objects`, `capital`, the same three the chassis uses — and `admin`. The group is also
the crumb the section prints, so `SETTINGS / CAPITAL` cannot name a place the nav does
not have; `admin: true` draws the row graphite for a member with `admin` in the right
lane rather than a link into a page that refuses, and changes no guard. Below `md` the
nav is the same rows as a horizontal strip above the content. `/settings` redirects to
the first row. `settings-nav.test.ts` holds the grammar the way `nav-grammar.test.ts`
holds the chassis'. The shell's loader carries what its readout counts; a section that
needs anything else loads it in its own child route's loader. A page that is _about_
one record rather than a section of settings stays outside the shell — that is why
`settings_.objects.$objectSlug.tsx` keeps its escaping `_`.

**A record** — the term page, a provider, a connection. → **`RecordHeader`**,
`apps/web/src/components/record/record-parts.tsx:21`, used as
`apps/web/src/routes/_app/deals_.$dealId.tsx:178` uses it: caps mono breadcrumb, actions
with key hints, mark + serif name + square badge, readout strip, then `RecordBody` with
the `PropertyGrid` and sections left and the bone rail right.

**A ledger of a stream** — the Context readout, a run log, a feed.
→ **Today's spine**, `apps/web/src/routes/_app/today.tsx:320`. `LedgerSection` with a
caps label, a mono count and one mono link right; 36px `LedgerRow`s on rules; a fixed
`LedgerFigure` lane the row ends on; `ReferenceBar` wherever a median exists; the last
row a composer, never a corner button.

**A two-axis grid has no precedent.** `ai-4b`'s lane × sensitivity routing grid is the
known case. Nothing in the vocabulary says what a cell, a head, or a selected
intersection looks like in a surface whose rows and columns are both dimensions. Draw it
on the canvas and have it approved before it is coded. Do not derive it from
`RecordTable` — that is rows of records, a different object.

### The nav grammar

A page reaches the chassis as **one row of data** in `NAV_ITEMS`
(`apps/web/src/components/app-sidebar.tsx`), and the row decides everything about
its place there. It joins one of the three groups — `work`, `objects`, `capital`
(`DESIGN.md` §5, "Navigation — the chassis") — by naming it in the row's `group`
field; the groups are derived by filter, so a row may be appended or inserted
anywhere without reshuffling them. Its G-chord is the row's `key` field: **data, not
a decision the slice that adds the page makes by hand.**
`apps/web/src/components/nav-grammar.test.ts` fails naming both pages when two rows
claim one letter, and it fails again on a chord that is not `G` plus a single letter
or a group that is not one of the three — so the chord is checked, not negotiated.

Rows stay grouped: the `group` values run `work` → `objects` → `capital` down the
array and never go back, which is what the old `slice()` arithmetic assumed without
checking, and the test holds it — so put the new row with its own kind rather than
at the end.

The sidebar (expanded and collapsed), the `?` keyboard sheet, the `⌘K` palette and
the G-chord binding in `routes/_app.tsx` all read that same array, so adding a page
edits nothing else — **one row, no other edit, the test included.**
**`NAV_ITEMS` order feeds the command palette** — and the sheet's Go column — so
those two surfaces read the array straight through; the test holds that each group
keeps that order and that the three together are the whole array, never a literal
list a new page would have to come back and amend.

---

## 4. What is enforced, what is judged

### The mechanical floor

The five gates in `CLAUDE.md`. Gate 5 is `instrument/vocabulary`
(`eslint-rules/vocabulary.js`), which reads `className` literals and the string
arguments of `cn()` / `cva()` in `apps/web/src/**/*.tsx` and names the replacement in
every message — a banned class, an unnamed size, or a raw colour (a hex or an
`rgb()`/`oklch()` spelled into a class; `var(--…)` is the sanctioned form). Green gates mean the vocabulary is spelled correctly. A surface can pass
all five and still be the wrong surface — that is what the checklist is for.

### The review checklist

Nineteen questions. A merge needs a yes to each.

**Vocabulary**

1. Is every colour a named token from the table, and every size a named step?
2. Is radius 2px on controls and 0 everywhere else — no pill, no circle, no blur?
3. Is every measured thing mono, and `numeric` where figures are comparable, with names
   and sentences in serif or sans outside the row's mono end lane?
4. Does the casing follow the three tiers — CAPS for structure, sentence case for
   anything a person clicks, lowercase mono only for what the instrument says about
   itself?

**The seven rules** (`DESIGN.md`, "The seven rules")

5. **Meaning** — does every colour name what it encodes (action, selection, state,
   stage, status)?
6. **Two-Tier** — is pine the only saturated fill, with badges a pale tint plus same-hue
   ink, square?
7. **Numeral** — see 3.
8. **Reticle** — is focus `focus-ring` / `focus-ring-inset`, never a ring and never
   pine?
9. **Dither** — 1-bit, pine or ink, never under text, never animated?
10. **Contrast floor** — body ≥ 4.5:1, graphite the only second text colour, no
    sub-100% opacity text?
11. **No-Bar** — no pine edge bar; current page is paper + rule + weight, a selected row
    is wash + check, a highlighted option is bone?

**Engineering** (`DESIGN.md` §5, "Interaction Engineering")

12. **No-Shift** — fixed dimensions on async slots, tabular figures on changing numbers,
    and weight never changes with state?
13. Are transitions named — no `transition: all`?
14. **Compositor** — transform and opacity only, exit faster than enter, nothing over
    250ms?
15. Does every layer come from the z-scale (`z-sticky … z-toast`), preferring
    `isolation: isolate` over climbing?
16. Keyboard parity — every working key printed inside the control it triggers,
    `aria-label` on icon-only buttons, Enter submits, bare keys off while typing?
17. Does the surface bound what it draws rather than paginating — a server-side
    cap, a grouping, or a `+ N more` fold? (`DESIGN.md` names virtualization past
    ~200 rows as the target; `RecordTable` deliberately does not carry it yet
    (`apps/web/src/components/table/record-table.tsx:27`), so a new surface
    inherits that limit rather than inventing a solution for it.)

**Shape**

18. Does it copy one of the five patterns in §3, named in the PR description?
19. Is the empty state the P5 anatomy, and was any modal argued for rather than reached
    for?

### afk or hitl

The same line the roadmap draws: **afk** is grabbable now, **hitl** needs the owner.

**afk — build it alone** when the surface is one of §3's five shapes, every token, step
and primitive it needs already exists, and the checklist answers yes nineteen times.
Everything in parts 1–3 is **pinned**: the token table, the type steps, the three
voices, the Casing Rule, the seven rules, the engineering rules, and the five patterns
with their files. None of it is open. Do not re-open it, and do not ask about it.

**hitl — stop and ask** when any of these is true:

- the surface is a shape §3 does not name (the two-axis grid is the known one);
- it needs a colour, a size, a radius, a shadow or a motion the vocabulary does not
  have;
- the honest answer is a new primitive rather than a composition of existing ones;
- a rule in the checklist has to be broken for the surface to work.

Say which of the four it is and ask. Never invent the missing half.
