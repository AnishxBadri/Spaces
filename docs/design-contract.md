# The design contract

Instrument is the design of Spaces. `DESIGN.md` describes it — what the system is and
why every part of it is that way. This file is the other half: what an agent does
before it builds a surface. Read this; open `DESIGN.md` only for the section a line
here sends you to.

`DESIGN.md` is the source. Nothing below invents language it does not already carry;
every statement traces to a `DESIGN.md` section or to a file that shipped. Where the
two disagree, `DESIGN.md` is right and this file is a bug — fix it here, not there.

Five parts: the vocabulary you may spell, the primitives that already exist, the
precedent every new surface copies, the line between what lint enforces and what a
reviewer judges, and what is decided but not yet built.

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
Shadows are named by kind and chosen by the primitive: a popover `shadow-dither` (4px,
Bayer 8/16), a window over the scrim `shadow-solid` (3px ink); a call site passes none
and gate 5 refuses `shadow-[…]`. Nothing blurs. Spacing is 4 8 12 16 24 32 and
the page gutter is 32 (`px-8`). Heights: table row 36 (`h-row`), ledger row 40 (`h-ledger-row`),
section head 44, tab bar 44, control 32, `Band` 28, `Segmented` 28, small 26, a row's `···`
24, badge 20, nav row 30, dialog head 48, dialog foot 52. The readout strip (56–64) stays
for Today and the holding's figures only; a record's readouts live in its Overview tab.

### The named type steps (`DESIGN.md` §3)

Eight steps, fixed rem, never fluid. The list is the `--text-*` custom properties in
`apps/web/src/styles.css` and the `NAMED_STEPS` table in `packages/config/eslint-rules/vocabulary.js`,
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
- **Mono** — money, counts, dates, durations, IDs, domains, key hints, kinds and stamps.
  Comparable figures take `numeric`. Column and field labels are sans (the Casing Rule).

Never a name or a sentence in mono, never a number in sans — with one shipped
exception: the fixed mono lanes a ledger row or a board card **ends** on are the
instrument's filing stamp, not prose, and a record or person name printed there is mono
graphite (`DESIGN.md` §5 P2's `LedgerFigure` and P4's `company · check`;
`apps/web/src/routes/_app/today.tsx:348`, `apps/web/src/components/deal-board.tsx:267`).

### The Casing Rule — three tiers (`DESIGN.md` §3)

The tier is decided by who is speaking, never by how small the text is. **Nothing starts
lowercase.**

- **CAPS mono** (`label-caps`) — only for kinds, stamps and band or group labels: a
  stamp (`COMPANY`), a kind lane (`CALL`, `STAGE`), a `Band` (`TASKS`, `LATEST`), a
  settings or sidebar or palette group, a plugin's group in a `···`. A page section's own
  head is titled in sentence case at the title step (below).
- **Sans 12 graphite, sentence case** (`text-label text-graphite`) — what labels a
  structure: `RecordTable` column heads, a ledger's lane heads, a record's property
  labels, the `Label` in forms and windows, and readout labels. Tabs are sentence-case
  sans too (`Tabs`, §2). `Due date`, `Last contact`, `In pipeline`.
- **Sentence case** — anything a person reads or clicks. Every control, button, chip,
  menu item and empty-state invitation, and `SettingsRow`'s 210px label lane. `Add
task`, `Due date`, `Keep open`.

A mono state word in an end lane is data, not a label: `fetching.`, `following`,
`■ gone` are what the instrument read, and keep their case (`field-label`, untransformed).
A key hint is data the same way, in the lanes A2 allows.

### The Separation Rule (`DESIGN.md` §5, 2026-10-05)

Every section separates itself by at least two of **material**, **space** and **ink
weight**:

- a hairline opens the section, then a 44px **bone head band** (`SectionHead`) carrying
  the title in sentence case at the title step, plus its tabs, filters and one action;
  dialog heads (48px) and feet are bone too;
- the section's count sits at the band's right in mono ink, **or** a `Segmented` in the
  band carries the counts — never both;
- a group inside a pane opens on a 28px **`Band`**: bone, a rule under it, its label in
  mono caps graphite, an optional link right (`All interactions ›`);
- rows sit on paper: **40px ledger rows**, the primary at body (14) in ink, at most one
  graphite meta line — a second line only when it is the row's description;
- **32–40px** between sections and groups, nothing but a rule between rows.

The record table keeps its 36px rows and paper head.

### The hierarchy ladders

Three ladders order everything on a surface, and none of them needs a new token.

- **Text.** A value is ink at 13–14; its label is sans 12 graphite; a kind is graphite
  mono caps. Nothing is lighter than graphite.
- **Surface.** Paper is work, bone is frame, bone-deep is pressed. An attribute grid is
  a bone label cell beside a paper value cell.
- **Line.** The double rule once, under the page head; ink is structure; a rule
  separates inside a pane; space separates inside a group.

### Dates

One set of forms, everywhere a date is printed:

- today: the time, `10:42` — or `Today` in a readout;
- this year: the day, `13 Oct`;
- an older year: `4 Oct 2024`.

Never `MM-DD`, never an ISO day in a lane. The formatter is hand-rolled and never
`Intl`, for the reason `fmtMoney` is: the server and the browser must print the same
string. Table date columns print the day. An age (`12d`) appears only in a stat column
(Last contact, Last email, Last filed) and only under 30 days; past that the column
prints the day. A readout prints the day with no `· Nd` tail (A8). Which rows print
the time and which the day is H3.

### Dither

Dither is 1-bit and never under text, and **it never moves at rest**. The one animated
dither is the `Twinkle`, and it is used only for a working state: a spinner never ships.
A popover is dithered (`shadow-dither`); a window is solid (`shadow-solid`).

### The Commentary Rule — data is dense, commentary is scarce

**The invariant-line test (2026-10-06).** Before a line of mono or graphite text ships
on a surface, ask whether it would read the same on every instance of that surface. If
yes, it is documentation: delete it, and put what it said in a tooltip on the control it
explained, or in the docs. If it varies — a count, a date, a provenance mark, a name, a
state word — it is data and stays. Foot notes under ledgers, subtitles under dialog
titles that restate scope, and "what happens next" sentences in dialog feet all fail the
test. The canvas is checked against it sheet by sheet; the reviewer checks the PR.

**A hint earns its place by cost (owner, 2026-10-08).** A visible hint appears only where
a wrong choice costs credits, privacy or something that cannot be undone: `pay as you
go`, `notes elsewhere never fetched`, a confirm's consequence. Everything else is a
tooltip on the control or the docs, and page blurbs go too.

**One close per dialog, and `esc` is never printed (2026-10-06).** A dialog closes from
its foot: `Cancel`, unmarked, beside the primary; neither prints a key (A6). The head carries
no standalone `esc` and no cross. `esc` is not printed anywhere, in a foot key list
either: it closes every dialog in every app, so it fails the invariant-line test. A
printed key earns its place only when the binding is ours and not guessable — `⌘↵` to
submit from inside a text field, `L`, `G T` — and then it is in the control's tooltip,
the `?` sheet and Cmd-K, never inside a button (A2). `↵` on a primary button or on the
highlighted row of a list is universal too, and is not printed. Amends P8's "esc right"
in the head and the `↵` on the Review card's primary. Built 2026-10-10: `DialogHeader`
holds the title and the context and nothing right, `DialogContent` has no close of its
own (Escape still closes; it is never printed), and `components/ui/dialog.test.tsx`
fails on an `esc` in the primitive. Every caller puts `Cancel` in its foot — a dialog
with no primary, like the file viewer or the keyboard sheet, carries `Cancel` alone. A
dialog subtitle that restates scope goes; a consequence survives only as the foot's note
beside the committing control.

**A readout is never a section count (2026-10-06).** The readout strip under a page or
record title carries derived and cross-cutting numbers — a ratio, a window, a next run, a
queue elsewhere — never the count a section head on the same page already prints. Cells
are equal lanes on rules with the number in mono 22 above a sentence-case graphite label;
a ratio prints as `1 / 2`. A readout is a number or a date, never a word: a state
(`needs a key`, `webhook`) belongs in the head's mono meta line, not in a cell. Providers
are shown by their own mark at 14–16px, never a monogram; degraded is the same mark at
reduced opacity.

Instrument density is measured density: readouts, ledger rows, five numbers in a
strip. It is never explanatory density. The drift to guard against is doctrine
written as interface copy — a footer under every card, a clause after every count,
a sentence in every cell explaining what will happen next. That layer argues the
architecture to a reviewer; the person at 8am needs the value.

- **One mono commentary line per section**, at the section head, and none in rows
  or cells. A row carries values. A cell carries its value and one provenance mark.
- **Provenance is a mark, not a sentence.** Who wrote a value and when is the
  hover or the receipt link, the way the shipped record pages already do it. The
  exception is a machine write: anything a plugin or a model wrote says so on the
  surface, in the cell, every time.
- **Consequence text lives on the confirming control only.** "cursor resets ·
  nothing is deleted" belongs in the dialog foot beside the button, never repeated
  in the list the dialog came from.
- **Tooltips explain behaviour; they never hold information.** What a control does —
  opens in Google, writes to Drive, what a switch shares — goes in its tooltip. A value
  the row should show (a summary, the people, a count, a date) stays on the surface.
- **Counts stay, clauses go.** `38 of 40 parse` is data; the reasons open on click.
- **Doctrine lives once.** A product truth — "every machine write is a suggestion" —
  is said on Welcome or in the `?` sheet, not on six pages. If a sentence starts
  with _because_ or _never_, it is doctrine and comes out of the surface.
- **Card feet** carry one status token and one action. Settings rows carry help
  only when the label does not explain itself.
- **An empty section is one `Name +` row (H1).** No sentence, no composer and no 0:
  the row names the section in graphite and is itself the way in (`EmptyRow`). The
  absence sentence survives only where absence is news —
  `Nothing matches that filter.` after a filter, not `No notes.` on a record that has
  none. A section with rows keeps its composer, whose hint text is an ellipsis
  invitation (`Write the memo…`, `Tag a company…`), not a sentence about what the
  section is for. Subheads
  inside a section are not a way to explain it: when rows come in two lanes, the lane
  is a mark in the row's mono end lane (`mention · note · 21 Sep`), never a second
  caps head over an empty list.

### The Action Grammar — one shape per element (2026-10-12)

Every control cluster in the app is one of the shapes below, and nothing else. The
walk of 2026-10-11 counted ten page-head shapes, eight record heads, ten row ends and
seven dialog feet for what is, each time, the same act; the grammar is what makes a
cluster predictable before it is read. A new surface is built to it; an existing one is
brought to it when its file is open. Cognitive load comes first: a rare act goes into a
menu, a dropdown or a tooltip, and state shows only when it is not the default — the
company head went from sixteen things to seven by this rule.

- **A1 · A page head carries one filled primary, at most one outline secondary to its
  left, and a boxed `···` at the far right.** All three are 32px. Nothing used less
  than weekly sits at rest; it is a `···` item. A head with no daily act has no filled
  button. A `···` that would hold one item is that item as the outline secondary (A7).
- **A2 · No key is printed inside a button.** A key lives in the button's tooltip, the
  `?` sheet and Cmd-K. Keys print on the surface only in a composer row's end lane and
  in the sidebar lane, where they are the row's data. Amends "printed inside the
  control it triggers" (`DESIGN.md`, Keyboard parity).
- **A3 · One act has one control per surface, and one label everywhere.** If a section
  has a composer row for a verb, the head does not also carry it; the key focuses the
  composer. The label is the same on every surface (`New task`, never `Task` /
  `Add task`).
- **A4 · A record head is `[verb] [verb] [···]` on every kind.** The verbs are the two
  most frequent for that object; Sensitive, Save as template, Copy link and Archive
  live in the `···`, which every record has. Navigation is a link in the title or the
  crumb, never an outlined button.
- **A5 · A row ends on a mono lane and a bare `···`.** The lane holds the row's figure
  or state word; the `···` appears on hover; the row itself is the link. No word that
  would read the same on every row (`void`, `record mark ›`, `raised`), and delete is
  never a bare icon.
- **A6 · A dialog foot is `note? · Cancel · Primary`.** Cancel is outline, the primary
  is filled, neither carries an icon or a printed key. There is one commit; a variant
  is a toggle beside it. The note is for cost, privacy or irreversibility only, and it
  wraps rather than truncates.
- **A7 · State is never a control.** No disabled button or menu item announces a
  missing setup; a `···` with no enabled item does not render; a menu of one item is
  that item as a button; a toggle shows its state as a switch, not as its label. Where
  something is missing, the place it would be used carries one link to fix it (D80).
- **A8 · A number prints once per screen.** The title or the tab carries a list's
  count, not both; a readout never repeats a section count and a section never repeats
  a readout; a row prints a date or an age, not both.
- **A9 · A create window asks only for identity.** Name plus the identity key (domain,
  email); everything else is `More fields ›`, inferred (company from email, deal name
  from company and stage, date today) or filled later by enrichment. Focus lands in the
  first field.
- **A10 · One tab bar shape, and it hides when there is one view.** Bone-bar tabs in
  sentence case, a count on every tab that holds something and none at 0; Filter ·
  Sort · Columns and search to the right; a nested switch is a bounded `Segmented`; a
  second axis is a chip in the bar, never a second row; the bar is absent when there is
  a single view.

Three more rules govern what a section or a list prints rather than how it is acted on.

- **H1 · An empty section is one `Name +` row.** The name in graphite and a `+`, with
  no sentence, no composer and no 0. The absence sentence survives only where absence
  is news (`Nothing matches that filter.`).
- **H2 · You are never listed among a row's people.** The viewer is left out of the
  people lane; a sent row reads `To X`.
- **H3 · A list prints the day.** The time lives in the viewer or a tooltip, and a long
  list breaks by week on bone bands. Today's rows and scheduled meetings show the time,
  because the time is what they are about.

---

## 2. The primitives that exist

Compose these. A new component is a last resort and needs the same argument a modal
needs. A row marked _decided_ is drawn and recorded but not in the code yet: it lands
before the surfaces that use it, and a surface that needs it waits rather than
hand-rolling one.

| primitive                                                                         | file                                                    | for                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`, `ReadoutStrip`                                                      | `apps/web/src/components/page-header.tsx`               | P1 — serif title, `[outline?] [Primary] [···]` right, the double rule under; no `KeyHint` (A2), and a count only when the page has no tab bar                                                                                      |
| `SectionHead`, `LedgerSection`, `LedgerRow`, `LedgerFigure`, `ReferenceBar`       | `apps/web/src/components/ledger-section.tsx`            | P2/P3 — bone head band (title left, mono ink count or a `Segmented` right, never both), 40px rows on rules, a fixed mono lane, value-vs-median                                                                                     |
| `Band`, `EmptyRow`, `FoldRow` (_decided_)                                         | `apps/web/src/components/ledger-section.tsx`            | `Band`: the 28px bone group head inside a pane, mono caps label, optional link right. `EmptyRow`: H1's `Name +` row on bone, the whole row the button; replaces `RailEmpty`. `FoldRow`: a 40px `25 more` row that unfolds in place |
| `RecordHeader`, `RecordBody`, `RecordSection`, `PropertyGrid`, `PropertyCell`     | `apps/web/src/components/record/record-parts.tsx`       | P7 — the record anatomy: the stamp alone above the title, no readout strip, the double rule, property grid, sections                                                                                                               |
| `RailSection`, `RailRow`, `RailItem`, `RailEmpty`, `StageStepper`                 | `apps/web/src/components/record/record-parts.tsx`       | the bone rail left of a record                                                                                                                                                                                                     |
| `InitialsMark`, `DitherMark`, `initialsOf`                                        | `apps/web/src/components/record/record-parts.tsx`       | ink initials squares and 1-bit fallback marks                                                                                                                                                                                      |
| `RecordTable`, `TableToolbar`, `AddColumnButton`                                  | `apps/web/src/components/table/record-table.tsx`        | the signature grid — sticky head, 36px rows, columns popover, `N OF M` foot                                                                                                                                                        |
| `useTablePrefs`                                                                   | `apps/web/src/components/table/use-table-prefs.ts`      | per-surface column order / visibility / width, under a frozen key                                                                                                                                                                  |
| `SelectionBar`, `useRowSelection`, `ListMenu`                                     | `apps/web/src/components/table/`                        | the 44px bone bar while rows are checked (count, controls, one pine verb); a list head's `···`                                                                                                                                     |
| `RecordLinkCell`, `IconBadge`, `InitialBadge`, `ChipLink`, `MetaCell`, `DateCell` | `apps/web/src/components/table/cells.tsx`               | the cell renderers a hand-declared column uses                                                                                                                                                                                     |
| `ViewBar`, `useViewState`                                                         | `apps/web/src/components/views/`                        | saved views — **object surfaces only** (`/companies`, `/deals`, `/people`, `/o/$slug`)                                                                                                                                             |
| `SettingsSection`, `SettingsRow`                                                  | `apps/web/src/components/settings/settings-section.tsx` | a section of the settings shell — serif title, sans sentence, mono crumb, 48px rows                                                                                                                                                |
| `SettingsNav`, `SETTINGS_SECTIONS`                                                | `apps/web/src/components/settings/settings-nav.tsx`     | the settings nav grammar — one row per section, groups derived, `admin` in the lane                                                                                                                                                |
| `EmptyState`                                                                      | `apps/web/src/components/empty-state.tsx`               | P5 — dither block, serif sentence, one sans line, the primary with its key                                                                                                                                                         |
| `DitherBlock`, `DensityRamp`                                                      | `apps/web/src/components/dither.tsx`                    | the only texture; loading is a density ramp, never a shimmer                                                                                                                                                                       |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogFooter`, …                      | `apps/web/src/components/ui/dialog.tsx`                 | P8 — 48px serif head + mono context, nothing right; 20px body; 52px bone foot, Cancel + primary; sizes below                                                                                                                       |
| `useConfirm`, `ConfirmDialog`                                                     | `apps/web/src/components/ui/confirm-dialog.tsx`         | the destructive confirm; it replaces `window.confirm` everywhere                                                                                                                                                                   |
| `Button`, `Input`, `Label`, `Popover`, `Tooltip`, `DropdownMenu`                  | `apps/web/src/components/ui/`                           | the atoms — reticle focus, 2px radius, keys in tooltips (A2)                                                                                                                                                                       |
| `Badge`, `badgeClasses`, `badgeTint`                                              | `apps/web/src/components/ui/badge.tsx`                  | the square option badge — takes the option row + index, `archived` and `unselected`                                                                                                                                                |
| `Select`, `selectClasses`                                                         | `apps/web/src/components/ui/select.tsx`                 | the one picker — an Input-height trigger, a paper sheet, `width` and `inset` per caller                                                                                                                                            |
| `Checkbox`, `checkboxClasses`                                                     | `apps/web/src/components/ui/checkbox.tsx`               | the 14px square that fills with pine; a button, never a native control                                                                                                                                                             |
| `Stamp`, `spaceStamp`                                                             | `apps/web/src/components/ui/stamp.tsx`                  | the ink stamp — a plain ink rectangle, 22px, the kind only in mono caps; outlined with the day when archived                                                                                                                       |
| `Tabs`, `nextTabIndex`                                                            | `apps/web/src/components/ui/tabs.tsx`                   | real tabs — one 44px bone bar, sentence-case sans tabs, mono counts hidden at 0, the open tab paper with a straight ink edge joining the body, ←→ Home End                                                                         |
| `Segmented`                                                                       | `apps/web/src/components/ui/segmented.tsx`              | the bounded switch — 28px, a bone-deep box, the selected segment paper, counts inside; a nested switch under a tab bar, never a second tab row                                                                                     |
| `Switch`, `switchClasses`                                                         | `apps/web/src/components/ui/switch.tsx`                 | the 24×14 square track — graphite knob off, pine knob on, legible from one switch                                                                                                                                                  |
| `MoreMenu` (_decided_)                                                            | `apps/web/src/components/ui/`                           | the one `···` — a boxed 32px trigger in a head, a bare 24px one on a row's hover; renders nothing with no enabled item and one item as that item's button (A7)                                                                     |
| `Twinkle` (_decided_)                                                             | `apps/web/src/components/twinkle.tsx`                   | the one animated dither — a 1-bit 4×4 grid stepping in Bayer order, for a working state only, still under reduced motion                                                                                                           |

### Windows

A window takes one of four widths: **S 440 · M 560 · L 768 · viewer 1152**. A confirm
or a one-field window is S, a form is M, a reading window (an email, a meeting, the
keyboard sheet) is L, and the file viewer is 1152 in every case. The size is the
primitive's prop, never a width the caller spells. A window opened from a window steps
down under its parent, and at most one is stacked: a third is refused. Cmd-K owns its
own size (D70).

### Pickers and dates (SPA-38)

**A picker is a paper sheet, never the operating system's.** `DESIGN.md` §5
"Menus / pickers" — paper, 1px ink, the dithered shadow, 28px rows, the highlighted row
in bone, 150/100ms — and `Select` (`apps/web/src/components/ui/select.tsx`) is that
sheet with a trigger in front of it. A native `<select>` draws the OS list instead:
rounded on macOS, a different font, a blue system highlight, and on a machine set to
dark OS chrome a dark list dropping out of a paper form. There are none left in
`apps/web`. Use `Select`; do not reach for `<select>` and do not build a third sheet —
the anatomy is Radix `Popover` plus cmdk `Command`, the same two pieces the command
palette and the attribute type pane are made of.

Three things the **caller** decides, because the primitive guessing them is how a
picker ends up the wrong width:

- `width="trigger"` — the sheet is the trigger's width. Short labels, few of them: the
  two-item invite role, the three-item status group.
- `width="content"` — the sheet sizes to its longest row, with the trigger as a floor.
  Labels that are sentences: the operator picker, the per-type slots in the attribute
  dialog, anything listing names.
- `inset` — `focus-ring-inset` instead of `focus-ring`, for a trigger inside a scroll
  container where the offset reticle would be clipped. The view bar's filter row is the
  case, and `select.test.tsx` holds it.

A search box appears at `SEARCH_FROM` rows and above (cmdk's own filtering); below that
the list gets letter type-ahead, ↑↓, ↵ and esc and no input, because a search field in
front of three words is chrome.

**A date field stays native, and that is a decision, not an omission.** `DESIGN.md` §5
"Inputs / Fields": _native control in forms_. A hand-built calendar is a month of work
and an accessibility regression — the platform picker already carries locale, keyboard
entry, screen readers and mobile. What makes it survivable is `color-scheme: light` on
`:root` (SPA-52, `apps/web/src/styles.css`): `color-scheme` is an **inherited**
property, so the one declaration reaches every `<input type="date">` and every
scrollbar in the app, and an operator on a dark OS gets a light calendar against the
paper form rather than a dark one bolted onto it. Nothing re-declares it — a second
declaration is the only way a field could go back to drawing dark, and
`design-tokens.test.ts` counts them. The one place a date is _not_ native is a table
cell, where `<input type="date">` would print a `mm/dd/yyyy` skeleton and a picker
glyph in every empty row; `DateCellEditor` (`value-editor.tsx`) reads as ISO text until
clicked, then hands over to the native control.

---

## 3. The precedent map

Every pending surface is one of five shapes. The shape decides the pattern; copy the
named file rather than designing. Name the pattern you copied in the PR description.

**A shelf** — a list of things with no object row behind them (`/documents`, Usage).
→ **`/portfolio`**, `apps/web/src/routes/_app/portfolio.tsx`. Hand-declared
`createColumnHelper` columns (`:54`), `RecordTable` + `TableToolbar` (`:230`),
`useTablePrefs` under a frozen key, `EmptyState` at zero. **No attribute registry and
no `ViewBar`** — saved views address objects, and a shelf is not one.

**A queue** — pairs or suggestions a human decides one at a time (`/review`, the
suggestion queue). → **`/review`**, `apps/web/src/routes/_app/review.tsx`. `PageHeader`
whose description is a mono count line, a `max-w-220` column of cards, each card
carrying its own accept/dismiss with a toast, `EmptyState` at zero. Not a table: a queue
row is a decision, not a cell.

**A settings section** — Integrations, Connections, Providers, Routing.
→ **the FX ledger**, `apps/web/src/routes/_app/settings/currency.tsx`, built from
`SettingsSection` and `SettingsRow`
(`apps/web/src/components/settings/settings-section.tsx`). The section is the page
(2026-09-30): the shell draws no head of its own, so the section head is P1 — a mono
eyebrow in sentence case (`Settings · Workspace`), the serif title in `title-serif`,
**no sentence under it** (page blurbs go, D81), the one action right, and the
**double rule** under the head (`double-rule`: a settings section is the page). The
content column is 700px inside the gutters (`max-w-[43.75rem]`, the Save bar matches).
A group inside a page is a mono caps label on a hairline (`SettingsGroupHead`:
`IDENTITY`, `PROVIDERS`, `RATES`, an optional mono count beside it), 28px above —
never the 44px bone `SectionHead` band. Rows (`SettingsRow`) are 48px on rules, the
label in a 210px lane and the controls in a left-aligned lane after it, never pinned to
the row's end. A field hint under the label survives only for cost, privacy or
something irreversible; any other explanation is a tooltip on the control
(`SettingsTip`) or goes. The nav left is the chassis grammar one level in: bone,
each group head a ruled band (mono caps in ink with a hairline under it, the
`LabelHead` grammar the settings ledgers use), 30px rows, counts in the right lane. A
ledger inside the section takes a head of sentence-case sans 12 graphite lane labels on
`border-y-hairline`, with lanes shared by head and rows. It carries no foot caption: a
line under a settings ledger survives only for cost, privacy or irreversibility (D81).

**A settings section is a child route under the settings shell** (SPA-26). `/settings`
is a layout — `apps/web/src/routes/_app/settings.tsx` — and every section is one file
under `apps/web/src/routes/_app/settings/` plus one row in `SETTINGS_SECTIONS`
(`apps/web/src/components/settings/settings-nav.tsx`). Never a section appended to
another section's file, and never a page of its own outside the shell: the eleven
pending sections (Providers, Routing, Usage, Integrations, the manifest form, install,
OAuth, Connections, Binding health, and the two embeddings slices) all take this one
answer. The row carries the path, the label, the `group` it joins — D81's four, by
whose it is: `you`, `workspace`, `ai`, `integrations` — and `admin`; a new section is
placed by D81's map, and its path follows its label (`/settings/email-forwarding`), with
a moved path answering one 301 from a route file at the old name
(`lib/settings-moves.ts`). The group is also the eyebrow the section prints, so
`Settings · Workspace` cannot name a place the nav does not have; `admin: true` draws
the row graphite for a member with `admin` in the right lane rather than a link into a
page that refuses, and changes no guard. At `md` and up settings takes over the chassis:
`‹ Settings` (and Escape, with no `esc` printed beside it) back to the page settings was opened from, Today on a cold
load, over the nav (`SettingsChassis`); below `md` the nav is the same rows as a
horizontal strip above the content. `/settings` redirects to the first row. `settings-nav.test.ts` holds the grammar the way `nav-grammar.test.ts`
holds the chassis'. The shell's loader carries what the nav's right lane counts; a
section that needs anything else loads it in its own child route's loader. A page that
drills into one row of a section — one object's attributes — stays inside the shell with
its section's row lit, and takes the `SettingsSection` head
(`settings/objects_.$objectSlug.tsx`; its `_` escapes only the index's component).

**A record** — the term page, a provider, a connection. → **`RecordHeader`**,
`apps/web/src/components/record/record-parts.tsx:21`, and `RecordBody` beside it. The
anatomy (D74 amended 2026-10-25):

- **Head.** The stamp alone on the first row, the kind only. Then the 28px mark, the
  serif name and its suffix (a parent path, a person's role, a deal's stage badge),
  with `[verb] [verb] [···]` (A4) at the right of that row — all outlined, keys in
  tooltips, a record head has no single affirmative to give pine to. Seven things at
  most. A custom object's head carries Log interaction when the object links people.
  Then the double rule, and **no readout strip**. A notices band sits under the double
  rule only while something needs saying (a possible duplicate, enrichment parked, the
  record archived).
- **Rail.** Left, 300px on bone (bone, not bone-deep, even beside a bone nav; the 1px
  rule separates): the attribute grid — a bone label cell beside a paper value cell,
  the empty attributes folded into one `n empty +` row — and then the relations (Team,
  Associated deals, Spaces, Waiting), each empty one an `EmptyRow`. Tasks are not in the
  rail.
- **View.** Right, at full remaining width under the 44px bone tab bar: Overview ·
  Notes · Interactions · Files · History. **Overview is first and opens every time**;
  no tab is remembered per kind. A tab that holds something carries its count; an empty
  tab is graphite with none. Overview holds the readouts that have a value (never a
  `—` or a 0), the open tasks with their composer, the latest three threads and the
  latest files, each group a `Band` ending on a link to its tab.
- **A space** is the same anatomy: the head is `···` only and the stamp prints no
  depth; Overview holds its readouts (in pipeline, last filed, the funding-stage bar),
  What's moving, open tasks and the latest companies; the rail is Criteria, Watching
  and Map (D73 amended 2026-10-25).
- **The holding** has one view and no tab bar, so its figures sit at the top of the
  pane as the readout strip.

There is no Context tab: Ask's answer card carries a `Sources n ›` footer instead. The
stacked sections of 2026-09-30, the readout strip under the title and the Notes default
of 2026-10-06 are superseded.

**A ledger of a stream** — Ask's sources footer, a run log, a feed.
→ **Today's spine**, `apps/web/src/routes/_app/today.tsx:320`. `LedgerSection` with a
bone head band with the title, a mono count and one link right; 40px `LedgerRow`s on rules; a fixed
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
its place there. It joins one of the four groups — `work`, `library`, `objects`,
`capital` (`DESIGN.md` §5, "Navigation — the chassis"; Library, Objects and Capital
fold per browser) — by naming it in the row's `group` field; the groups are derived by filter, so a row may be appended or inserted
anywhere without reshuffling them. Its G-chord is the row's `key` field: **data, not
a decision the slice that adds the page makes by hand.**
`apps/web/src/components/nav-grammar.test.ts` fails naming both pages when two rows
claim one letter, and it fails again on a chord that is not `G` plus a single letter
or a group that is not one of the four — so the chord is checked, not negotiated.

Rows stay grouped: the `group` values run `work` → `library` → `objects` → `capital`
down the array and never go back, which is what the old `slice()` arithmetic assumed without
checking, and the test holds it — so put the new row with its own kind rather than
at the end.

The sidebar (expanded and collapsed), the `?` keyboard sheet, the `⌘K` palette and
the G-chord binding in `routes/_app.tsx` all read that same array, so adding a page
edits nothing else — **one row, no other edit, the test included.**
**`NAV_ITEMS` order feeds the command palette** — and the sheet's Go column — so
those two surfaces read the array straight through; the test holds that each group
keeps that order and that the groups together are the whole array, never a literal
list a new page would have to come back and amend.

---

## 4. What is enforced, what is judged

### The mechanical floor

The five gates in `CLAUDE.md`. Gate 5 is `instrument/vocabulary`
(`packages/config/eslint-rules/vocabulary.js`), which reads `className` literals and the string
arguments of `cn()` / `cva()` in `apps/web/src/**/*.tsx` and names the replacement in
every message — a banned class, an unnamed size, or a raw colour (a hex or an
`rgb()`/`oklch()` spelled into a class; `var(--…)` is the sanctioned form). Green gates mean the vocabulary is spelled correctly. A surface can pass
all five and still be the wrong surface — that is what the checklist is for.

### The review checklist

Twenty-seven questions. A merge needs a yes to each.

**Vocabulary**

1. Is every colour a named token from the table, and every size a named step?
2. Is radius 2px on controls and 0 everywhere else — no pill, no circle, no blur?
3. Is every measured thing mono, and `numeric` where figures are comparable, with names
   and sentences in serif or sans outside the row's mono end lane?
4. Does the casing follow the three tiers? See 27.

**The seven rules** (`DESIGN.md`, "The seven rules")

5. **Meaning** — does every colour name what it encodes (action, selection, state,
   stage, status)?
6. **Two-Tier** — is pine the only saturated fill, with badges a pale tint plus same-hue
   ink, square?
7. **Numeral** — see 3.
8. **Reticle** — is focus `focus-ring` / `focus-ring-inset`, never a ring and never
   pine?
9. **Dither** — 1-bit, pine or ink, never under text, still at rest, with the `Twinkle`
   the only animated dither and only for a working state — never a spinner?
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
16. Keyboard parity — every working key in its control's tooltip, the `?` sheet and
    Cmd-K (printed on the surface only in a composer row's end lane or the sidebar
    lane), `aria-label` on icon-only buttons, Enter submits, bare keys off while typing?
17. Does the surface bound what it draws rather than paginating — a server-side
    cap, a grouping, or a `+ N more` fold? (`DESIGN.md` names virtualization past
    ~200 rows as the target; `RecordTable` deliberately does not carry it yet
    (`apps/web/src/components/table/record-table.tsx:27`), so a new surface
    inherits that limit rather than inventing a solution for it.)

**Shape**

18. Does it copy one of the five patterns in §3, named in the PR description?
19. Is the empty state the P5 anatomy, and was any modal argued for rather than reached
    for?
20. **Commentary** — one mono commentary line per section and none in a row or a
    cell; provenance a mark or a hover except for a machine write; consequence text
    only beside the control that commits it; no sentence on the surface that starts
    with _because_ or _never_; every empty section one `Name +` row (H1), no subhead
    over an empty list; tooltips explain behaviour and hold no value the surface
    should show? (§1, "The Commentary Rule")
21. **Separation** — does every section separate itself by at least two of material
    (bone head, paper rows), space (32–40px between groups) and ink weight (hairline
    opens, rules between rows), with the title in sentence case at the title step and
    the count at the band's right or in a `Segmented`, never both? (§1, "The
    Separation Rule")
22. **Action Grammar** — does every cluster follow it: one filled primary, keys in
    tooltips not buttons, one control per act, state never a control? (§1, "The
    Action Grammar")

**Hierarchy, dates and casing**

23. **H1** — is every empty section one `Name +` row, with no sentence, no composer
    and no 0, and does an absence sentence appear only where absence is news?
24. **H2** — is the viewer left out of every row's people, and does a sent row read
    `To X`?
25. **H3** — does every list print the day, with the time in the viewer or a tooltip,
    a long list broken by week on bone bands, and the time printed only on today's rows
    and scheduled meetings?
26. **Dates** — is every date one of the forms (`10:42` today, `Today` in a readout,
    `13 Oct` this year, `4 Oct 2024` older), hand-rolled, never `MM-DD` and never
    `Intl`, with an age (`12d`) only in a stat column and only under 30 days? (§1,
    "Dates")
27. **Casing** — is CAPS mono used only for kinds, stamps and band or group labels; are
    tabs, column heads, lane heads, property and field labels and readout labels
    sentence-case sans, the labels 12 graphite; and does nothing start lowercase except
    a mono state word in an end lane? (§1, "The Casing Rule")

### afk or hitl

The same line the roadmap draws: **afk** is grabbable now, **hitl** needs the owner.

**afk — build it alone** when the surface is one of §3's five shapes, every token, step
and primitive it needs already exists, and the checklist answers yes to every question.
Everything in parts 1–3 is **pinned**: the token table, the type steps, the three
voices, the Casing Rule, the hierarchy ladders, the dates, the seven rules, the
engineering rules, the Action Grammar with H1–H3, and the five patterns with their
files. None of it is open. Do not re-open it, and do not ask about it.

**hitl — stop and ask** when any of these is true:

- the surface is a shape §3 does not name (the two-axis grid is the known one);
- it needs a colour, a size, a radius, a shadow or a motion the vocabulary does not
  have;
- the honest answer is a new primitive rather than a composition of existing ones;
- a rule in the checklist has to be broken for the surface to work.

Say which of the four it is and ask. Never invent the missing half.

---

## 5. Decided, not yet built

Approved on the canvas and recorded, but not in the code yet. A slice that touches one
of these surfaces builds toward the decided shape, not the shipped one; a slice that does
not touch it leaves the shipped one alone. Each line names its decision and the work that
carries it. Project 27 is "Instrument, printed — the decided design lands"; project 30
is "The canvas lands — the instrument port".

**The canvas port** (project 30; D63, D64, D70, D73, D74, D79 and D81 amended
2026-10-25). The rules are in §1, the primitives marked _decided_ in §2, the record
anatomy in §3. The surfaces:

- **Lists.** The head is the title with no count, `[New <x>]` and a `···`; applied
  filters are chips in a row under the bar, shown only while a condition exists. A
  row's `···` shows on hover: Open in a new tab · Add to space… · Enrich… · Copy link,
  and Archive once records archive; there is no Delete. Bulk is Enrich… (outline) and
  Add to space, with no Tag. Deals switch `Table | Board` with a `Segmented` in the
  bar, not a view tab. A first-run list is one `Name +` row.
- **Today** (D79 amended): the head is the title and the day (`Thu 15 Oct · W42`) with
  no verbs and no count; Notices, then Needs you, then Meetings; the day strip only with
  a connected calendar.
- **Undo holds the write.** Accepting or dismissing a suggestion, a duplicate or an Ask
  card hides the row and holds the write for 5s; the toast's `Undo` is sans and
  underlined.
- **Windows.** A confirm's dismiss says Cancel; a reply opens as Reply; the sizes and
  the stacking are §2's.
- **Cmd-K and Ask** (D70 amended): Cmd-K is one fixed size in every state with its
  preview pane always mounted, blank bone when nothing previewable is highlighted; Ask's
  scope chips sit in the composer; a citation previews its passage on hover; Ask's row
  is at the sidebar foot (`⌘J`).
- **Shell.** Upload leaves the account row; the workspace head opens General · Members ·
  Invite; a password reset is a one-time link an admin issues; the phone drawer prints
  no key hints; sidebar counts are ink, destructive only when something is overdue.
- **Settings** (D81 amended): the nav group heads are ruled bands; Integrations is
  Connections · Plugins · Enrichment · Email forwarding; a settings head carries one
  outline 32px action at most beside its `···`.

**The printed details** (`DESIGN.md` §1, §5 "Printed details"; project 27, `print-*`). The double rule, the
stamp and real tabs are built (§2) as the `double-rule`, `stamp`, `stamp-outline` and
`tab-open` utilities in `apps/web/src/styles.css`. So are the elevation split
(`shadow-dither` on a popover, `shadow-solid` on a window, chosen in the primitives) and
the sticky head (`HeadBar`, inside `PageHeader` and `RecordHeader`).

- **Dither is data**: charts, readout history, 1-bit marks, popover elevation; one moment
  per region.

**The frame** (project 27, `shell-*`; D68 amended, D70 amended)

- **Sidebar A** with the collapsible Library group: `DESIGN.md` §5 "Navigation — the
  chassis". `NAV_ITEMS` gains the `library` group and the nav-grammar test with it;
  Documents becomes Files (keeping `G L`), Meetings is new (`G E`).
- **The sidebar's current row is a hairline box on paper** (`border-hairline`, `bg-paper`),
  inside the chassis, expanded and collapsed alike — never a tab cut through the
  chassis edge, never a pine bar. Decided by the owner 2026-10-10, reversing the
  2026-10-08 shell verdict "active row as a tab cut".
- **Cmd-K finds only**; Tab hands the query to Ask. **Ask** is a docked 408px column
  plus `/ask`, one thread store, answers in sans (D70 amended; project 24). Its sidebar
  row moves to the foot (project 30, above).

**Settings** (D81; project 27, `settings-*`)

- You is Email & calendar, Files, Meeting notes, API tokens; Connections stands in for
  the first three until `settings-3`. (The four groups and the takeover shipped: §3.)
- Toggles apply at once; typed fields share one Save bar shown only while dirty.
- Confirms on revoking a token, suspending a member, archiving an object, unticking an
  identity key.
- A member sees an admin page read-only, with who can change it; no "Admins only" page.
- No footer caption strips.
- **The plugin page template** and **the account page** (`DESIGN.md` §5 "Settings");
  Plugins is a catalogue, Installed then Available by job.
- The sensitivity floor sits at the top of AI → Models; Search reuses the Models key;
  the Models grid has no Embed row.

**Pages** (project 27 unless named)

- **Today** (D79, `today-1`): plain title with the date, the day strip, derived readouts
  only, one notices band, one Needs-you ledger with a kind lane (task, meeting, review,
  deal, mark), Today's meetings, and a rail of Portfolio and What's moving. Amended by
  the canvas port (above).
- **First run** (D80, `first-run-1`): Today's empty state with three ways in; each
  missing setup named in place with one link; Settings → General → What's set up; demo
  data offered with Start empty as the primary.
- **Meetings page** (D68 amended): Upcoming by day with Prep, Past with no-write-up rows
  first and Write, filters All · Upcoming · Past · No write-up · Mine.
- **The space page in the record anatomy** (D73, D74, both amended 2026-10-25): tabs
  Overview · Companies · Notes · Files · People · Records with Overview by default; its
  three readouts (in pipeline, last filed, the funding-stage mix) in Overview; rail
  Criteria, Watching, Map; a head of `···` alone, holding Find companies, Rename, Move
  to…, Split into a subspace…, Save as template…, Glossary…, Sensitive and Archive;
  archive asks nothing and Restore undoes it.
- **The Enrichment page** (D76): sources in order with what each sends, auto-enrich
  scopes, What fills what per object, recent runs; the where-from popover on a filled
  value; Fill from on an attribute.
- **The Find table** (D77, project 24): results as rows with Add / File here / Dismiss
  checked against what is held, and the Save as watch window.
- **Notes filed from a tool** (D78): serif with a `via <tool>` mark; the Notes tab gains
  a From meetings filter.
