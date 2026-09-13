---
name: DealOS
description: Self-hosted deal-management OS for angel and private-capital investing
colors:
  paper: '#ffffff'
  bone: '#f4f3ef'
  bone-deep: '#e9e7e1'
  hairline: '#1c1c1a'
  rule: '#d6d4cd'
  graphite: '#5c5b56'
  ink: 'oklch(0.24 0.012 155)'
  pine: 'oklch(0.55 0.14 155)'
  pine-hover: 'oklch(0.5 0.14 155)'
  selected-wash: 'oklch(0.962 0.022 155)'
  destructive-crimson: 'oklch(0.48 0.17 12)'
  success-teal: 'oklch(0.55 0.09 190)'
  warning-amber: 'oklch(0.7 0.13 75)'
  info-blue: 'oklch(0.55 0.1 240)'
typography:
  display:
    fontFamily: 'Source Serif 4 Variable, Georgia, serif'
    fontSize: '1.75rem'
    fontWeight: 600
    lineHeight: '2rem'
    letterSpacing: '-0.01em'
  section:
    fontFamily: 'Source Serif 4 Variable, Georgia, serif'
    fontSize: '1.125rem'
    fontWeight: 600
    lineHeight: '1.375rem'
  prose:
    fontFamily: 'Source Serif 4 Variable, Georgia, serif'
    fontSize: '1.0625rem'
    fontWeight: 400
    lineHeight: '1.6875rem'
  title:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.9375rem'
    fontWeight: 500
    lineHeight: '1.375rem'
  ui:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.8125rem'
    fontWeight: 400
    lineHeight: '1.25rem'
  readout:
    fontFamily: 'JetBrains Mono Variable, ui-monospace, monospace'
    fontSize: '1.25rem'
    fontWeight: 500
    lineHeight: '1.5rem'
  numeral:
    fontFamily: 'JetBrains Mono Variable, ui-monospace, monospace'
    fontSize: '0.8125rem'
    fontWeight: 400
    lineHeight: '1rem'
  label:
    fontFamily: 'JetBrains Mono Variable, ui-monospace, monospace'
    fontSize: '0.6875rem'
    fontWeight: 500
    lineHeight: '1rem'
    letterSpacing: '0.08em'
rounded:
  none: '0px'
  control: '2px'
spacing:
  row: '2.25rem'
components:
  button-primary:
    backgroundColor: '{colors.pine}'
    textColor: '#ffffff'
    rounded: '{rounded.control}'
    padding: '0 12px'
    height: '32px'
  button-primary-hover:
    backgroundColor: '{colors.pine-hover}'
  button-outline:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    borderColor: '{colors.hairline}'
    rounded: '{rounded.control}'
    padding: '0 12px'
    height: '32px'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    height: '32px'
  input:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    borderColor: '{colors.rule}'
    rounded: '{rounded.control}'
    padding: '0 10px'
    height: '32px'
---

# Design System: DealOS

## 1. Overview

**Creative North Star: "Instrument" — a measuring instrument for capital, printed
output.**

The interface is a bench instrument that measures a fund and prints what it found:
paper for the data field, bone for the chassis, one ink for structure, one LED for the
action. Everything the instrument measured — money, counts, dates, durations, IDs,
domains — is set in mono, because a reading is a reading. Everything a human wrote —
a company's name, a page title, a thesis — is set in serif, because a person named it.
The sans carries the interface between them. Density done the Attio way, speed felt the
Linear way, character carried by type and material, never by the surface.

Instrument (2026-09-10) replaces "The Analyst's Desk" (2026-07 → 09). What it kept: the
white ground, the one pine voice, the contrast floor, the ledger register. What it
changed: the second neutral is bone, structure is 1px ink rather than a pale border,
numbers and labels moved to mono, titles moved to serif, radius fell to 0 and 2px,
focus became a reticle, and dither became the only texture. The Paper canvas
(`spaces`, pages `v2 · Foundations / Components / Patterns / Surfaces`) is the drafting
table; this repo is truth.

This system explicitly rejects enterprise CRM chrome, the generic SaaS template look
(shadcn defaults, gradient heroes, purple accents, identical card grids), and the dark
terminal aesthetic. Mono here is a voice for readings, not a costume for the whole app.

**Key Characteristics:**

- Paper data field, bone chassis, ink structure, one pine LED
- Three type voices — serif where a human wrote it, sans for the interface, mono for
  everything measured
- Keyboard-first; every key that works is printed inside the control it triggers
- Nothing blurs, nothing rounds past 2px, nothing is a pill
- WCAG AA is a floor, not a target: body text ≥ 4.5:1, always

## 2. Colour

Two untinted neutrals, one ink, one LED. Semantic colour only where it encodes state.
Badges are a tint plus same-hue ink, square. Every value is live in `src/styles.css` —
this section describes; the CSS decides.

### Materials

| token       | value                  | role                                       |
| ----------- | ---------------------- | ------------------------------------------ |
| `paper`     | `#FFFFFF`              | the data field — tables, records, dialogs  |
| `bone`      | `#F4F3EF`              | the chassis — sidebar, rails, dialog feet  |
| `bone-deep` | `#E9E7E1`              | pressed, disabled, archived rows           |
| `rule`      | `#D6D4CD`              | inner rules — rows, cells, inputs          |
| `hairline`  | `#1C1C1A`              | 1px structure — sections, sheets, the edge |
| `graphite`  | `#5C5B56`              | the second text colour, 5.9:1 on paper     |
| `ink`       | `oklch(0.24 .012 155)` | text, 13:1 on paper                        |
| `pine`      | `oklch(0.55 .14 155)`  | the LED — primary action, live segments    |

The neutrals are hex on purpose: they are the physical materials of the bench, not
points on the brand hue. Ink keeps its whisper of 155° so text and pine belong to each
other. Row hover is opaque bone, never a translucent tint (a tint over a sticky column
lets the scrolled-under columns bleed through).

### Pine

`oklch(0.55 0.14 155)` ≈ `#00884b`. Primary action, the active tab's 2px underline, the
filled segments of a stage stepper, sparkline end-dots, the `+` that starts a composer.
Third primary, by owner decision (2026-08): Ochre Gold fell to contrast physics
(2026-07), Vermilion to preference for a quieter, capital-coded voice. Lightness is
pinned by contrast — 0.55 measures 4.52:1 under white text, by proper OKLCH→sRGB
conversion, never eyeballed. Hover deepens to `oklch(0.5 0.14 155)`, 5.51:1. The
selection wash is a pale same-hue tint, `oklch(0.962 0.022 155)`, 14.8:1 under ink.

### Semantic

- **Destructive** — deep crimson `oklch(0.48 0.17 12)`: delete, overdue, past 2× median.
- **Warning** — amber `oklch(0.7 0.13 75)`: unpriced, missing FX; as a row wash it uses
  the amber badge tint with amber ink.
- **Success** — teal `oklch(0.55 0.09 190)`, moved off green (2026-08) because pine owns
  green and a state must never share the action's hue.
- **Info** — `oklch(0.55 0.1 240)`.

A readout is coloured only when its value is nonzero and bad; a zero reads in graphite.

### Badge palette

Twelve hues (slate → cyan) for select, status and stage options, every one a pale tint
at L 0.955 with same-hue ink at L 0.45, chroma fitted to the largest the sRGB gamut
allows. The worst pair measures 6.26:1, the best 7.02:1. Badges are square, 18–20px
tall, mono 11 medium. Options get a hue auto-assigned; users can override per option.

## 3. Type — three voices

**Serif** where a human wrote it · **Sans** for the interface · **Mono** for everything
the instrument measured. Inter Variable (`cv11` + `ss01`), Source Serif 4 Variable and
JetBrains Mono Variable, all self-hosted via Fontsource — no font CDN calls from a
privacy product.

| voice | step              | size / leading | role                                           |
| ----- | ----------------- | -------------- | ---------------------------------------------- |
| serif | display · 600     | 28 / 32        | page titles, record names, the Today sentence  |
| serif | section · 600     | 18 / 22–24     | dialog titles, settings sections, empty states |
| serif | prose · 400       | 17 / 27        | note bodies, theses, reasons                   |
| sans  | title · 500       | 15 / 22        | a name inside a readout cell                   |
| sans  | ui · 400 / 500    | 13 / 20        | rows, forms, buttons, the workhorse            |
| sans  | body · 400        | 14 / 20        | composer inputs, running UI text               |
| mono  | readout · 500     | 18–20 / 22–24  | the readout strip                              |
| mono  | numeral · 400     | 13 / 16        | money, counts, dates, IDs, domains in rows     |
| mono  | label · 500 caps  | 11 / 14, .08em | column labels, section labels, field labels    |
| mono  | field label · 400 | 10 / 12 caps   | labels inside cells and readouts               |
| mono  | key hint · 400    | 11 / 14        | `⌘K G T ↵ ⇧↵ M esc` — inside the control       |

Utilities: `title-serif`, `label-caps`, `mono`, `numeric` (tabular + right-aligned in
one class), `tabular` (figures inline in a sentence). The sans scale steps stay named
(`text-micro … text-display`); if a size isn't on the list it does not go in the app.

## 4. Material and scale

Structure is 1px ink. Inner rules are 1px rule. Nothing blurs.

- **Rules.** Hairline for sections and the chassis edge; rule for rows, cells and
  inputs; 2px pine for the active tab underline; 2px ink for the reticle.
- **Depth.** Card · 0 (rule border). Popover · 2 (`shadow-[2px_2px_0_0_var(--hairline)]`).
  Dialog · 3 (`shadow-[3px_3px_0_0_var(--hairline)]`). Toast · ink. Every lifted sheet is
  paper with a 1px ink edge and a hard offset shadow. No blur, ever.
- **Spacing.** 4 8 12 16 24 32; the page gutter is 32.
- **Heights.** Row 36 · control 32 · small 26 · badge 20 · nav row 30 · header row 48 ·
  readout strip 56–64 · dialog head 44 · dialog foot 52.
- **Radius.** 0 on chassis, cards, badges, dialogs, sheets. 2px on controls and inputs.
  No 4, 6, 8, 12. No pills. No circles — initials sit in ink squares.
- **Texture.** Dither, 1-bit, Bayer 4×4 at 2px cells, pine or ink. See the Dither Rule.

## The seven rules

**The Meaning Rule.** Colour only encodes: action, selection, state, stage, status. If a
colour can't name what it encodes, it is forbidden. Kept from 2026-07.

**The Two-Tier Rule.** Pine is the only fully saturated fill on a surface. Badges are a
pale tint with same-hue ink, square. Kept from 2026-07; radius dropped.

**The Numeral Rule.** Every measured thing is mono: money, counts, dates, durations, IDs,
domains, column labels. Prose and names never are. New, 2026-09-10.

**The Reticle Rule.** Focus is four 2px ink crop marks 3px outside the control
(`focus-ring`), inset inside scroll containers (`focus-ring-inset`). Never pine, never a
ring. Replaces the Focus Rule.

**The Dither Rule.** Dither is 1-bit, pine or ink, Bayer 4×4 at 2px cells. Never under
text, never animated, never a third colour. It lives in empty states, chart fills,
fallback marks, thumbnails and loading. New, 2026-09-10.

**The Contrast Floor.** Body ≥ 4.5:1, graphite 5.9:1, no sub-100% opacity text. Kept.
Key hints on pine are the one exception, at 85% and still ≥ 4.5:1.

**The No-Bar Rule.** Pine never appears as an edge bar. Current page = paper + rule +
weight. Selected row = wash + check. Highlighted option = bone. Winner = ink vs graphite.
Pine is left for the primary action, the active tab underline and end-dots. New,
2026-09-10.

Two older rules survive underneath them: **The Tabular Rule** (comparable figures are
tabular and right-aligned — `.numeric` makes the two halves one class) and **The Two
Registers Rule**, now the three voices above.

## 5. Components

Refined and restrained: every interactive element ships with default, hover,
focus-visible, active and disabled states; empty states teach; loading is a density
ramp, never a shimmer. Documented from the shipped code (2026-09-10, the Instrument
port) — the reticle, the three voices and the motion doctrine apply to every component
without exception.

### Motion

**Pure CSS, used extensively, never decoratively.** No JS animation runtime — Radix
`data-state` attributes + `tw-animate-css` keyframes + Tailwind transitions carry
everything, which is what lets the one global `prefers-reduced-motion` query silence the
entire app. Principles, after Rauno Freiberg's interface guidelines:

- **Compositor-only.** Animate `transform` and `opacity` exclusively — never width,
  height, top, or margin.
- **Every transient surface enters and exits** — fade + slight scale (0.95 → 1); nothing
  pops into existence unstyled.
- **Origin-aware.** Overlays scale from their trigger (`transform-origin` from Radix's
  placement variables), never from screen center.
- **Exit faster than enter, frequency scales the numbers.** Dialogs/palette: 180ms in,
  120ms out. Menus: 150/100. Tooltips: 120/80. Cell edits and hovers: ≤100ms or nothing.
  All on `--ease-out-quart`.
- **Interruptible, never blocking. No load choreography** — pages appear settled.
- **Pressed states are physical.** Buttons compress to `scale(0.97)` on press. No bounce,
  no springs — tool, not toy.
- **Dither never moves.** A density ramp is a still picture of "filling in".

**The Compositor Rule.** If a motion can't be expressed in transform + opacity, it
doesn't ship.

The canvas sheet **Micro-interactions** (`v2 · Components`, 2026-09-11) draws each
interaction frame by frame with its contract as a mono line: button press, ledger row
states, overlay enter/exit, composer add, field edit, drag reorder, toast and loading,
chassis fold, tabs, badge toggle. Four specifics on that sheet are proposed, not yet in
code: a composer's new row lands on a bone wash that fades in 250ms; a rejected cell
write snaps back and reads crimson in place for 2s; toasts rise 8px as they fade in; a
pending button drops its key hint with the label swap.

### The Page Shell (2026-09, one mode since 2026-09-11)

**One page mode, Field.** Every route's outermost container is
`flex min-h-full flex-col`, edge to edge: the `PageHeader` or `RecordHeader` runs the
full width with its hairline (the hairline is what ties the page to the chassis, so it
must reach the edge), and the body insets 32px (`px-8`). Content starts at the same
left edge on every page; navigating never moves it.

Prose caps its measure, it does not center. A memo, a thesis, the mandate, the note
editor and a glossary definition sit left at the gutter under `max-w-160` (640px, or
the editor's own `72ch`); the space to the right is margin — the sheet comes out of the
instrument at the left edge. Settings and Dedupe cap wide bodies at 880px the same way.

The old **Column** mode (800px centered, no head strip; 2026-09 → 2026-09-11) is gone:
its pages had become ledgers, its hairline never reached the chassis, and its left edge
jumped ~200px against every Field page. `--container-column` was retired with it.

### Interaction Engineering (2026-09, after Emil Kowalski)

The engineering floor under the aesthetics — vendored in full as the
`design-engineering` skill (`.claude/skills/design-engineering/`), with the
load-bearing rules promoted here:

- **The No-Shift Rule.** Dynamic content never moves its neighbors: fixed
  dimensions on async slots, tabular figures on changing numbers, and **weight
  never changes with state** — hover/selected speak through color and the wash,
  not font-weight. (The current nav page is the one exception: paper + rule +
  medium, per the No-Bar Rule.)
- **Name your transitions.** `transition: all` is banned — list the properties.
- **Hover is an enhancement.** Nothing requires hover to function; Tailwind v4
  already gates `hover:` behind `(hover: hover)` — never undo it. Controls take
  `touch-action: manipulation`; on coarse pointers inputs render ≥16px (iOS
  zoom) and hit areas reach 44px even when the visual is smaller.
- **Keyboard parity.** Tab reaches only visible elements (`inert` the hidden),
  keyboard focus scrolls into view, Enter submits forms, Cmd/Ctrl+Enter submits
  textareas and dialogs, icon-only buttons carry `aria-label`. Bare-key
  shortcuts (`useHotkey`: T task, L log, M move stage) are ignored while typing
  and inside dialogs, and every one is printed inside the control it triggers.
- **The z-index scale.** sticky 150 · modal 200 · dropdown 250 · tooltip 300 ·
  toast 400 — the utilities `z-sticky … z-toast`, no other values; menus sit above
  modals because a picker opened from inside a dialog floats over it; prefer
  `isolation: isolate` over climbing (the record table isolates its sticky head and
  pinned column). Sonner takes the toast layer as an inline style.
- **Virtualize past ~200 rows.** The ledger stays dense by drawing less, not
  by paginating.

### Buttons

- **Shape:** 2px radius, heights 26 / 32 (`sm / default`); the `xs` 24px step is for
  icon-only.
- **Primary:** the only saturated fill on any surface — pine under white text, hover
  deepens to pine-hover, press compresses to 0.97. It carries its key hint inside:
  `<kbd class="mono text-micro opacity-85">⌘↵</kbd>`.
- **Outline:** paper, 1px hairline, hover tints to bone. No shadow.
- **Ghost:** transparent until hover; for in-context quiet actions.
- **Destructive:** crimson fill, white text — never adjacent to a primary without space.
- **Focus:** the reticle. Never a ring.

### Inputs / Fields

- **Style:** transparent background, 1px rule, 2px radius, 32px height. No shadow.
- **Focus:** the reticle, drawn on the input's own background (inputs can't host
  `::after`). Two exceptions, decided 2026-09-11: a title-style input (the borderless,
  full-width input that _is_ the head of a sheet, as in the quick task) draws no marks —
  the caret in a fresh sheet is the focus, and corner marks on that box read as a frame
  around the head; a borderless input inside a bordered composer row draws the marks on
  the row (`focus-ring-within`), never on the invisible input box.
- **Labels:** the `Label` atom is a 10px caps mono field label in graphite.
- **Placeholders:** full-strength graphite — never a sub-100% opacity.
- **Invalid:** border shifts to destructive; a required-and-empty field gets an amber
  square, not a red border.
- **Date fields:** native control in forms; in table cells a date renders as ISO text
  until clicked.

### Page header + readout strip (P1)

`PageHeader`: serif title (or a sentence when the page has a state to report — "Seven
things need you. Two are late."), a mono eyebrow above or a mono readout line below,
actions right with key hints inside the buttons, hairline under, 32px inset, 28px above.
`ReadoutStrip`: cells split by rules on a hairline, caps mono label, mono 20/500 value,
colour only when nonzero and bad.

### Ledger section + attention row (P2 · P3)

`LedgerSection`: caps label + mono count left, one mono link right, hairline under the
head, 36px rows on rules, the last row may be a composer (`+ Add a task…  T`). Notes
splits its ledger by ISO week (THIS WEEK · `W37`, then EARLIER); Spaces is one ledger of
the market-map tree with `›` at a 24px indent per depth; the Mandate's facts are a
one-column property grid under the head (stages as badges with the unselected ones
dashed, geographies as square chips with an inline add, the check size as mono inputs)
above the prose. Every row
ends on a fixed mono lane (`LedgerFigure`, 64 or 80px, right-aligned). A number is never
shown alone when a median exists: `ReferenceBar` draws the value in ink, the median as a
graphite tick, the track as rule — 1-bit, no colour.

### The Record Table (signature)

The hardest-working surface; spreadsheet-grade or the audience leaves.

- **Rows:** one `--row-h` (36px) shared by header and body; rules between rows.
- **Header:** 32px, sticky, paper, caps mono labels in graphite. Header cells are
  buttons: the menu carries Sort A→Z / Z→A, Clear, Hide; the sort direction reads as a
  mono arrow after the label; the chevron appears on hover. Hairline under the head.
- **Cells:** `text-ui`; measured columns `.numeric`; empty cells render an em dash in
  graphite. Editors open in place: ↵ commits, esc reverts. Status is never cell-edited —
  it reads a badge, and M opens Move stage on the record so the reason gets logged.
- **Foot:** 32px on a hairline — `N OF M` caps left, `end` right.
- **Focus inside the scroll container:** `focus-ring-inset`, never the offset marks.
- **Columns popover:** paper sheet, 2px shadow, caps head `COLUMNS · 7 OF 19` + reset,
  square checkbox rows in bone when highlighted.

### Typed Value Editors (signature)

One implementation shared by table cells, record property grids and create dialogs —
`variant` only changes chrome. `field` rests as a value (rule on hover, reticle on
focus); `cell` is borderless inside the row. Selects and multi-selects render square
option badges; the actor picker an ink initials square; references a 1-bit mark;
ratings are ink squares with a mono `n/max`; checkboxes are 14px squares that fill
with pine. Pickers are paper sheets with the 2px shadow and highlight in bone.

### Option Badges

Square chips carrying select / status / stage values: pale tint background + same-hue
ink from the twelve-hue palette, mono 11 medium, 18–20px tall, 6px inset. Data colours,
never decoration; the Two-Tier Rule guarantees they never compete with pine.

### Navigation — the chassis

232px of bone with a hairline right edge. Three groups: the work (Today, Tasks, Spaces,
Notes), the objects (Companies, People, Deals, then customs), capital (Portfolio,
Mandate). Rows are 30px with a 14px mark slot so every label sits on one lane. Current
page = paper + rule border + medium weight — never a pine bar. The head row ends on a
mono `«` that folds the chassis (`⌘\`). The foot is one account row (ink initials
square, name, email); its menu opens to the right of the chassis — never up into the
corner — and holds Settings (`G ,`) and Sign out. Collapsed, the chassis is 48px of
marks only: the mark on a hairline (which expands it again), `⌘K` on a rule, 36px rows
with a 24px rule between groups, the current page in a 36×32 paper box, names on hover
as ink tooltips. Width snaps (never animates) and the preference is per browser.
Collapses to a drawer under a 48px top bar on mobile.

### Record Pages (P7)

`RecordHeader`: mono caps breadcrumb (`DEALS / 7C335C4A / OPENED 2026-07-29`), actions
with key hints (Log interaction L · Task T · Move stage M), a 28px mark (1-bit dither
tile, or ink initials for a person) beside the serif name and a square badge, then a
56px readout strip of the numbers that matter. Body left: the property grid (three
columns, hairline top and bottom, rules inside, 96px caps labels), then Notes, Ledger
and Files as sections. Rail right on bone (360px): the stage stepper (one 8px segment
per live stage, pine to the current one, hairline after), tasks, people. The rail is
sticky; the body scrolls. Deals, companies, people, custom records and holdings share
the parts.

- **The Ledger.** Three lanes on rules — mono `MM-DD HH:MM`, mono caps type
  (`CALL · STAGE · FILE · EDIT · BORN`), sans body. Attribute bursts expand in place.
- **The Composer Row.** Adding to a stream never starts from a corner button: a 36px
  row with a pine `+`, graphite hint text and the key that opens the real dialog
  (`+ Log a call, meeting, or note…  L`). The Tasks page grows it into the bone
  composer band (P6): paper input, square chips, create-more switch, `Add task ↵`.

### The Board (P4)

224px columns whose head is a mini readout strip — square stage badge, count, Σ,
median — on a hairline. Paper cards on rule borders: 1-bit mark + name, `company ·
check` mono with days in stage (crimson past 2× median), `close MM-DD · Nd` with the
owner's initials. A dashed `+ N more` folds long columns; a pine dashed `drop →
Stage` box appears while dragging over a column.

### Overlays (P8)

- **The attribute sheet:** 660px, two panes under the 44px head (`New attribute` ·
  mono `on Companies · 19 → 20`): a 236px type pane on a rule with the pine `›` search
  and 26px rows (mono glyph lane, label, the chosen row on bone), the form right (name
  with its frozen mono slug beneath, description, the per-type slot, default and
  required on one line), the bone foot saying where it lands. In edit mode the pane
  stays, greyed — the type is the record of what this is.
- **Dialogs:** paper sheet, 1px ink, 3px hard shadow, 0 radius. 44px head — serif
  title 18/600, mono context beside it, `esc` in the right lane, hairline under. 20px
  body. 52px bone foot — mono note left ("what will happen · counts"), buttons right,
  the primary carrying ⌘↵. The first field takes the reticle on open. Wide (560px)
  for forms, 420–480 otherwise; the quick task has no title bar — the input is the
  title. A modal must be argued for.
- **The options editor** (inside the attribute sheet): a rule-bordered box of 30px rows
  — `⋮⋮` grip, a 14px square swatch, the borderless label, a mono status group — with a
  composer as the last row (`+ Add option… or paste a list`; a pasted list becomes
  rows). Saved options archive, struck in graphite with a mono `restore`; only unsaved
  rows can be removed. Hue is auto-assigned; the swatch opens a grid of square swatches,
  never circles.
- **The object sheet:** singular and plural side by side, the plural marked `guessed` in
  mono until touched; a 1-bit icon grid of 32px tiles, the chosen one ink; the derived
  slug shown frozen in a bone box (`/o/funds · /o/funds/<id>`); the foot says records are
  born with a required name and objects archive, never delete.
- **Confirm:** 440px, no title bar — an 8px crimson square beside the serif question,
  one sans sentence saying what happens and what does not, an optional rule-bordered
  ledger of what is affected (name left, mono meta right), then the bone foot: Keep
  takes focus, the destructive button carries ⌘↵. `useConfirm()` replaces
  `window.confirm` everywhere; a confirm exists to be read, never to be clicked through.
- **Menus / pickers:** paper, 1px ink, 2px hard shadow, 28px rows, highlighted row in
  bone, 150/100ms.
- **Command palette:** 640px; a pine `›` prompt, `↑↓ move · ↵ open` on the right, caps
  group labels, 32px rows, the `↵` hint on the highlighted row, a 32px bone foot.
- **The keyboard sheet:** `?` opens it (the account menu lists it). Two columns of 26px
  rows on rules — Go, Create, On a deal, In a sheet — with 18px keycaps (hairline, 2px
  foot, mono 10). Only keys that work are printed. Every nav row prints its G-chord in
  its right lane; chords wait 800ms and every key is off while typing.
- **Tooltips:** inverted (ink background, paper text), `text-label`, 120/80ms.
- **Toasts:** sonner, bottom-right, ink.

### The Auth Sheet

Login, setup and join share one anatomy (`AuthShell`): a 400px column on paper, the
mark, a mono caps eyebrow naming the step (`SIGN IN`, `SETUP · STEP 1 OF 2`,
`INVITATION · ADMIN`), a serif title, one sans sentence, a hairline, the form, a mono
foot. The primary prints `↵`; errors are a crimson square and one sentence. No card,
no centering flourish — a page head printed at the top of an empty field.

### Empty States (P5)

Centered, max 24rem: a 160×120 dither block (a pine density ramp with a paper sheet
set in), a serif sentence 20/600, one sans line in graphite, the primary action with
its key. A table should almost never be empty at all (demo seed exists for that).

### Settings

The section pattern: serif title 18, one sans sentence, a mono crumb (`SETTINGS /
CAPITAL`) right, hairline under; then 48px rows on rules with the control on the right.
Tables inside settings use the ledger primitives unchanged — the FX rates ledger is the
example, and its foot says what the model does: rates are append-only, a new date
supersedes, nothing edits.

An object's attributes are a settings ledger too (2026-09-11): a caps column head on a
hairline — ATTRIBUTE · TYPE · CONSTRAINTS · ORIGIN · ORDER · EDIT — with the lanes shared
by head and rows so they stay one grid; rows on rules with a `⋮⋮` grip lane, the name
with its description under it, the raw type slug in mono, a mono constraints lane
(option count, target, currency, out of n, required, default), a caps origin tag (system
on bone, custom on the selection wash), and always-visible `↑ ↓ ✎ archive` marks in
graphite. Select rows carry their square option badges beneath, archived options struck
on bone. The foot says what the order feeds. Archived attributes fold into a collapsed
ARCHIVED section with a Restore button and no grip. `A` opens New attribute.

## 6. Do's and Don'ts

### Do:

- **Do** keep the data field paper and the chassis bone; let ink, pine and type carry
  all character.
- **Do** set every measured thing in mono, and every comparable figure `.numeric`.
- **Do** hold body text at ≥ 4.5:1 — graphite is the only second text colour.
- **Do** print every working key inside the control it triggers.
- **Do** use density confidently in the ledger; calm comes from rules and rhythm, not
  sparseness.

### Don't:

- **Don't** draw a pine bar on any edge — the No-Bar Rule. Current, selected and
  highlighted have their own treatments.
- **Don't** blur a shadow, round past 2px, or make a pill or a circle.
- **Don't** put dither under text, animate it, or give it a third colour.
- **Don't** set a name or a sentence in mono, or a number in sans.
- **Don't** use color decoratively. No gradient text, no side-stripe borders, no
  glassmorphism.
- **Don't** animate for decoration. Motion conveys state; no entrance choreography,
  nothing over 250ms.
- **Don't** reach for a modal first. Inline and progressive disclosure are the defaults;
  modals are the exception that must be argued for.
