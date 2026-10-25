---
name: Spaces
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

# Design System: Spaces

_This file describes the system and is the source for it. To **build** a surface, read
`docs/design-contract.md` first — it names the vocabulary, the primitives by file, the
shipped route each shape copies, and the checklist a reviewer runs, and it sends you
back here by section. It restates nothing this file does not say; where they disagree,
this file is right._

## 1. Overview

**Creative North Star: "Instrument, printed" — a measuring instrument for capital,
and the sheet it prints.**

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
focus became a reticle, and dither became the only texture. There is no predecessor
still running and no flag to flip: the old look survives only in the commit
history.

**Printed** (adopted by the owner 2026-10-08; port: project 27) adds four details of
printed matter, each with a budget so none becomes wallpaper. They are specified under
"Printed details" in §5:

- **Double rule** — 2px ink, 2px gap, 1px ink. Page heads only.
- **Ink stamp** — a plain ink rectangle naming the kind of thing the page is (`COMPANY`,
  `SPACE`). One per page; outline when the thing is archived.
- **Real tabs** — the open tab is paper with a straight ink edge, joined to the body
  below it. Tab bars only.
- **Dither is data** — charts, readout history, 1-bit fallback marks and popover
  elevation. One moment per region.

The Paper canvas is the drafting table; this repo is truth. File `spaces`
(id `01M19X8AY9DZD3PZMJK7RWVMTB`). The decided drafts are its printed pages: Files,
Email, Cmd-K, Spaces, Shell, Ask, Settings, Enrichment + Exa, Meetings + Granola and
Today. Foundations, Components, Patterns and Surfaces hold the shipped Instrument
sheets. Open a page with `open_file(fileId, pageId)`, then `get_tree_summary` to find
nodes, then `get_jsx(nodeId, "inline-styles")` for exact values; never read a value
off a screenshot, and use screenshots only to compare a result.

This system explicitly rejects enterprise CRM chrome, the generic SaaS template look
(shadcn defaults, gradient heroes, purple accents, identical card grids), and the dark
terminal aesthetic. Mono here is a voice for readings, not a costume for the whole app.

**Key Characteristics:**

- Paper data field, bone chassis, ink structure, one pine LED
- Three type voices — serif where a human wrote it, sans for the interface, mono for
  everything measured
- Keyboard-first; every key that is ours to know is in its control's tooltip, the `?`
  sheet and Cmd-K — never printed inside a button
- Printed: one double rule, one stamp, real tabs, dither only for data
- Nothing blurs, nothing rounds past 2px, nothing is a pill
- WCAG AA is a floor, not a target: body text ≥ 4.5:1, always

## 2. Colour

Two untinted neutrals, one ink, one LED. Semantic colour only where it encodes state.
Badges are a tint plus same-hue ink, square. Every value is live in `src/styles.css` —
this section describes; the CSS decides.

**Light only, by decision (2026-09-19):** `:root` declares `color-scheme: light` so the
native controls follow the app rather than the OS, there is no `dark` variant, and every
colour is a token — a raw hex or an arbitrary colour value in tsx is a lint error — so
dark, when it is built, is a second token file and not a redraw.

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

| voice | step             | size / leading | role                                                    |
| ----- | ---------------- | -------------- | ------------------------------------------------------- |
| serif | display · 600    | 28 / 32        | page titles, record names, the Today sentence           |
| serif | section · 600    | 18 / 22–24     | dialog titles, settings sections, empty states          |
| serif | prose · 400      | 17 / 27        | note bodies, theses, reasons                            |
| sans  | title · 500      | 15 / 22        | a name inside a readout cell                            |
| sans  | ui · 400 / 500   | 13 / 20        | rows, forms, buttons, the workhorse                     |
| sans  | body · 400       | 14 / 20        | composer inputs, running UI text                        |
| mono  | readout · 500    | 18–20 / 22–24  | the readout strip                                       |
| mono  | numeral · 400    | 13 / 16        | money, counts, dates, IDs, domains in rows              |
| sans  | label · 400      | 12 / 16        | column, lane, property, field and readout labels        |
| mono  | label · 500 caps | 11 / 14, .08em | kinds, stamps, band and group labels                    |
| mono  | data word · 400  | 11 / 16        | state words and units in an end lane — `field-label`    |
| mono  | key hint · 400   | 11 / 14        | `⌘K G T ↵ ⇧↵ M` — tooltips, composer end lanes, sidebar |

**Who wrote it decides the voice** (owner 2026-10-08; D78):

- A note a person filed from a tool (a Granola note in a ticked folder) is serif, with a
  mono `via <tool>` mark: the person chose to file it.
- Text a model wrote that nobody chose is sans: an Ask answer, Exa's brief, an unfiled
  summary. Ask answers are sans in the panel and on `/ask`.

Utilities: `title-serif`, `label-caps` (the 11/14 500 caps label step whole), `field-label`
(the 11/16 400 data word whole — mono, untracked, its case left as written), `mono`,
`numeric` (tabular + right-aligned in one class), `tabular` (figures inline in a
sentence). The scale steps
stay named (`text-field … text-display`, the smallest being the field step at 10/12); if
a size isn't on the list it does not go in the app — `instrument/vocabulary` rejects
`text-[…]` and `leading-[…]` in tsx, so the only way onto the list is `src/styles.css`.
A genuine one-off (optical sizing of initials inside a 16–22px square) takes an inline
comment saying why and a scoped disable; there are four.

**The Casing Rule** (2026-09-15, tiers redrawn 2026-10-11 and 2026-10-25). Three tiers,
and the tier is decided by who is speaking, never by how small the text is. Nothing
starts lowercase:

- **CAPS mono** (`label-caps`) — only for kinds, stamps and band or group labels
  (`COMPANY`, `CALL`, `TASKS`, `IDENTITY`). A page section's own head is titled in
  sentence case at the title step (see The Separation Rule, §5).
- **Sans 12 graphite, sentence case** — what labels a structure: column and lane heads,
  property labels, field labels in forms and windows, readout labels. Tabs are
  sentence-case sans as well. `Last contact`, `Due date`, `In pipeline`.
- **Sentence case** — anything a person reads or clicks. Every control, every button,
  every chip, every menu item, every empty-state invitation, and a settings row's
  210px label lane. `Add task`, `Due date`, `Assign to`, `Keep open`, `+ Link record`.

A mono state word in an end lane (`fetching.`, `following`, `■ gone`) is data, not a
label, and keeps its case; so does a key hint in the lanes that print one.

The failure this rule was written against: the task composer's chips were controls
dressed as annotations — `date…`, `assign to me`, `+ link record`, `create more` — sat
in one row, same font and box, 8px from `Today` `Tomorrow` `Next week` `No date`. A
control in lowercase mono reads as a caption of the thing beside it, not as a thing you
can press.

## 4. Material and scale

Structure is 1px ink. Inner rules are 1px rule. Nothing blurs.

- **Rules.** Hairline for sections and the chassis edge; rule for rows, cells and
  inputs; 2px pine for the active tab underline; 2px ink for the reticle.
- **Depth.** Card · 0 (rule border). Popover · `shadow-dither`. Window · `shadow-solid`.
  Toast · ink. Every lifted sheet is paper with a 1px ink edge and a hard shadow. No
  blur, ever.
- **Elevation, printed** (decided 2026-10-08). Two kinds of lift, told apart by what
  sits behind them:
  - A **popover** (menu, picker, the palette's pop-outs) has no scrim, so it casts a 4px
    dithered ink shadow (Bayer 8/16, 1-bit): `shadow-dither`, the sheet's own border
    image, outside its 1px ink edge and never under its paper.
  - A **window** (dialog, viewer, confirm, the palette) sits over the scrim, where
    dither vanishes, so it keeps a solid 3px ink offset: `shadow-solid`.
  - The primitives choose (`Popover`, `DropdownMenu`, `Select`, the BlockNote sheets;
    `DialogContent`). No call site passes a shadow; gate 5 refuses `shadow-[…]`.
- **Spacing.** 4 8 12 16 24 32; the page gutter is 32.
- **Heights.** Table row 36 · ledger row 40 · section head 44 · tab bar 44 · control 32 ·
  band 28 · segmented 28 · small 26 · a row's `···` 24 · badge 20 · nav row 30 · header
  row 48 · readout strip 56–64 (Today and the holding's figures only) · dialog head 48 ·
  dialog foot 52. The record table keeps 36: it is a spreadsheet and density is its
  job; every ledger (record sections, Today, settings ledgers) is 40.
- **Radius.** 0 on chassis, cards, badges, dialogs, sheets. 2px on controls and inputs.
  No 4, 6, 8, 12. No pills. No circles — initials sit in ink squares.
- **Texture.** Dither, 1-bit, Bayer 4×4 at 2px cells, pine or ink. See the Dither Rule.

## The seven rules

**The Meaning Rule.** Colour only encodes: action, selection, state, stage, status. If a
colour can't name what it encodes, it is forbidden. Kept from 2026-07.

**The Two-Tier Rule.** Pine is the only fully saturated fill on a surface. Badges are a
pale tint with same-hue ink, square. Kept from 2026-07; radius dropped.

**The Numeral Rule.** Every measured thing is mono: money, counts, dates, durations, IDs,
domains. Prose and names never are, and since 2026-10-25 neither are column labels. New,
2026-09-10.

**The Reticle Rule.** Focus is four 2px ink crop marks 3px outside the control
(`focus-ring`), inset inside scroll containers (`focus-ring-inset`). Never pine, never a
ring. Replaces the Focus Rule.

**The Dither Rule.** Dither is 1-bit, pine or ink, Bayer 4×4 at 2px cells. Never under
text, never moving at rest, never a third colour. The one animated dither is the
**Twinkle**, a 4×4 grid stepping in Bayer order, and it marks a working state only:
nothing spins (amended 2026-10-25). It lives in empty states, chart fills,
fallback marks, thumbnails and loading. New, 2026-09-10. Amended 2026-10-08 (printed):
**dither is data** — a chart, a readout's history, a 1-bit mark, and the elevation of a
popover. One dither moment per region; a page that already has one adds no second.

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
ramp, never a shimmer. Documented from the shipped code (2026-09-10) — the reticle,
the three voices and the motion doctrine apply to every component without exception.

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

The canvas sheet **Micro-interactions** (canvas page `v2 · Components`, 2026-09-11)
draws each interaction frame by frame with its contract as a mono line: button press, ledger row
states, overlay enter/exit, composer add, field edit, drag reorder, toast and loading,
chassis fold, tabs, badge toggle. Four specifics on that sheet shipped 2026-09-19
(SPA-53), each beside the code that already owned the state rather than as an animation
layer:

- **Composer add.** A row a composer just created lands on a bone wash that fades out
  over 250ms. The wash is the row's own `::before` at `z-index: -1`, so only opacity
  animates (`row-wash`, `apps/web/src/styles.css`); `LedgerRow` takes it through a
  `wash` prop (`apps/web/src/components/ledger-section.tsx`). Which rows wash is decided
  by who created them, never by how young they are: `useBornRows`
  (`apps/web/src/lib/born-rows.ts`) starts empty on mount and grows only when a composer
  reports the id its write returned, so a list the loader filled washes nothing and a
  reload moments after an add washes nothing either. In code on `/tasks` (the composer
  band), `/today` (the spine's composer row) and `/spaces` (the market map's).
- **Field edit, refused.** A rejected attribute write snaps back to the stored value —
  the remount `RailField` already did — and the cell reads crimson in place for 2s, off
  the same rejection `setValues` already returns, with no second ask of the server. The
  crimson is a pane over the cell, not a border on it, so nothing moves by a pixel
  (`rejectPaneClass` / `PropertyCell`,
  `apps/web/src/components/record/record-parts.tsx`; the clock is in
  `apps/web/src/components/attributes/rail-field.tsx`). It arrives at full strength —
  a snap has nothing to fade in from — and leaves on opacity over 120ms.
- **Toast.** Rises 8px as it fades in, 180ms in and 120ms out, on the frequency scale's
  dialog tier. sonner's own 400ms slide and its `height` / `box-shadow` transitions are
  overridden in `apps/web/src/styles.css`, which leaves transform and opacity and
  nothing else.
- **Pending button.** `Button` takes `pending`, publishes it on a context, and `KeyHint`
  reads it: `Save ⌘↵` becoming `Saving…` drops the keycap for an action that is no
  longer armed, and reclaims it when the action re-arms. The hint fades on opacity and
  never unmounts, so the width it holds is the width it keeps — the No-Shift Rule — and
  it leaves the accessibility tree with the paint
  (`apps/web/src/components/ui/button.tsx`, `apps/web/src/components/page-header.tsx`).

All four are transform and opacity only, so the one global `prefers-reduced-motion`
query in `apps/web/src/styles.css` silences every one of them; the crimson hold is a
state rather than a motion, so it still holds its two seconds there.
`apps/web/src/components/micro-interactions.test.ts` reads the stylesheet and the class
helpers and holds all of that.

**Row exit** (2026-09-15, in code on Tasks). A row that leaves because you acted on it
strikes through and fades to 0 over 150ms, and the write is held until the transition
ends — the row leaves, the list does not flinch. Opacity only; the row keeps its height
until it unmounts, so nothing below it jumps. Anything irreversible-feeling pairs the
exit with an undo in the toast; anything actually irreversible (delete) asks first.

**Waiting chip** (2026-09-23, SPA-114; D44). Open suggestions on a record show as
chips in a `Waiting` rail section at the top of the company, person, deal and
custom-record rails — one chip per suggestion kind, the reference chip's shape
(`.mention-chip`: 20px, bone, rule edge going hairline on hover), a `Sparkles` mark, a
mono count and a sans word (`5 proposed`, `2 notes`). It is a **pointer, never a verb**:
the chip is a link into `/inbox?record=<id>&lane=suggestions`, and accept and reject
live only there, so the bulk accept (SPA-110) keeps one path. Grouping by kind caps the
lane at five chips however many suggestions wait, and a record with none draws no
section and no zero (`apps/web/src/components/record/waiting-rail.tsx`). SPA-72's
`proposed` table cell and SPA-103's pending space tags inherit this chip: same shape,
same mark, same rule that pending machine output points at the inbox rather than
carrying its own accept.

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
  and inside dialogs, and every one is in its control's tooltip, the `?` sheet and
  Cmd-K. A key prints on the surface only in a composer row's end lane and the sidebar
  lane, where it is the row's data; never inside a button (contract §1, A2).
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
  deepens to pine-hover, press compresses to 0.97. Its key is in its tooltip, never
  printed inside it (contract §1, A2).
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
- **Labels:** the `Label` atom is sans 12 graphite in sentence case, 6px above its
  control; an error sits under the control in destructive 12.
- **Placeholders:** full-strength graphite — never a sub-100% opacity.
- **Invalid:** border shifts to destructive; a required-and-empty field gets an amber
  square, not a red border.
- **Date fields:** native control in forms; in table cells a date renders as ISO text
  until clicked.
- **Switches** (2026-09-15): a 24×14 square track with a 10px square knob, 2px of
  padding, no radius. Off is a rule track on paper with a **graphite** knob; on is the
  pine selection wash with a pine border and a **pine** knob. State must be legible
  from one switch alone — position is not a state, it is a consequence of one, so a
  track that only moves an ink block is a bug (it reads as a stray mark). The knob
  travels on `translate-x`; the Compositor Rule holds inside controls too. One
  implementation, `Switch` (`apps/web/src/components/ui/switch.tsx`), since 2026-09-19
  (SPA-22): a `<button role="switch" aria-checked>` and not Radix's Switch, which would
  bring its own focus treatment and the Reticle Rule has no exceptions left. `children`
  is the label the control reads as, so track and text share one hit area and one
  reticle.
- **Checkboxes**: a 14px square that fills with pine and carries a 10px check — never a
  native rounded control, never a circle. Unchecked rests on paper inside a hairline and
  tints to bone on hover, the way a highlighted option does. One implementation,
  `Checkbox` (`apps/web/src/components/ui/checkbox.tsx`), since 2026-09-19 (SPA-22),
  also a `<button role="checkbox" aria-checked>`: no call site sits inside a form that
  submits — each writes through a server fn the moment it is toggled — so there is no
  name/value pair for a native input to contribute. The caller owns the label and the
  hit area around it.

### Printed details (decided 2026-10-08; port: project 27)

Four details from printed matter, each with a budget. A surface that spends a detail
outside its budget is wrong even when it looks good.

- **Double rule.** 2px ink, 2px gap, 1px ink, under a page head (P1, a record head, a
  settings page head). Nowhere else: a section opens on the single hairline as before.
- **Ink stamp.** A plain ink rectangle, 22px, mono caps inside, naming the kind alone:
  `COMPANY`, `SPACE`. One per page, on its own row above the title. An archived thing's
  stamp turns to outline with the day (`ARCHIVED 8 Oct`).
- **Real tabs.** A tab bar's open tab is paper with a straight ink edge, joined to the
  body under it with no rule between; the others sit on bone. Tabs are sentence case,
  with a mono count on a tab that holds something and none at 0. Tab bars only (a
  record's Overview · Notes · Interactions · Files · History head, a space's tabs,
  `/ask`). A nested switch under a tab is a bounded **Segmented** — 28px, a bone-deep
  box, the selected segment paper, counts inside — never an underline row or a second
  tab bar.
- **Dither is data.** See the Dither Rule. A space's funding-stage mix bar, a readout's
  history, a portfolio chart and a popover's shadow are dither; a section head, a
  button or a page background never is.

### The Separation Rule — sections and separation (2026-10-05)

A page reads as stacked sections, and each section separates itself from its neighbours
by at least two of three means: **material**, **space**, **ink weight**. Approved by the
owner on 2026-10-05 after the storage and email drafts read as one flat plane. The
shared primitives draw it — `SectionHead` (the band, inside `LedgerSection`,
`RecordSection`; a group inside a settings page is a caps label on a hairline instead,
`SettingsGroupHead`), `LedgerRow` at `h-ledger-row`, `DialogHeader`,
the confirm — so every surface built on them follows; rows sit 12px in from the
band's edge, under its title.

- **Material.** A section head is a 44px band on bone — title, count, tabs, filters and
  the head's one action live in it. A Drive folder band is the same band; a settings
  page is the page, so its groups take no band. A group inside a pane opens on a 28px
  bone **band** with a mono caps label and an optional link right. Dialog heads and feet
  are bone. Rows sit on paper.
- **Scale.** The section title is the title step (15/22, sans 500, sentence case); its
  mono count sits at the band's right in ink, or a Segmented carries the counts, never
  both. A row's primary is body (14/20) in ink; at most one graphite meta line under it.
  Tabs, column heads and field labels are sentence-case sans (The Casing Rule, §3).
- **One line, then a second when it is content.** A ledger row leads with one 40px
  line; secondary facts go to fixed lanes. A second graphite line is right when it is
  the row's description — an email's people and summary, a meeting's participants.
- **Space.** 32–40px between sections and groups; nothing wider than a rule between
  rows inside one.
- **Ink weight.** A hairline opens a section, above its bone head; rules sit between
  rows.
- **Values on the surface, behaviour in tooltips.** The surface shows values and state.
  A tooltip explains what a control does — opens in Google, writes to Drive, what a
  switch shares — and never holds information the row should show. A consequence of a
  destructive act lives on its confirm.

### Page header + readout strip (P1)

`PageHeader`: serif title (or a sentence when the page has a state to report — "Seven
things need you. Two are late."), a mono eyebrow above or a mono readout line below,
actions right as `[outline]? [filled] [···]` with keys in tooltips (contract §1, A1 and
A2), hairline under, 32px inset, 28px above.
`ReadoutStrip`: cells split by rules on a hairline, a sans 12 graphite label, mono 20/500
value, colour only when nonzero and bad. Since 2026-10-25 it serves Today and the
holding's figures only; a record's readouts live in its Overview tab.

Decided 2026-10-08/09 (port: project 27):

- **Sticky head.** On scroll the head collapses to a 40px bar (stamp, title, actions);
  the readout strip scrolls away under it. Built into `PageHeader` and `RecordHeader`
  (`HeadBar`): the bar hangs from a zero-height sticky anchor on `z-sticky` and enters
  on transform and opacity (180/120ms); the head's own actions are lifted into it, never
  copied, so each hotkey stays bound once.
- **Today takes a plain title** with the date (D79). The sentence title stays available
  to a page with a state to report, but Today no longer uses it.
- **Double rule** under the head instead of the single hairline (Printed details).

### Ledger section + attention row (P2 · P3)

`LedgerSection`: a bone head band on a hairline — sentence-case title at the title step
and a mono count left, one link right — then 40px rows on rules, the last row may be a composer (`+ Add a task…  T`). Notes
splits its ledger by ISO week (THIS WEEK · `W37`, then EARLIER); Spaces is one ledger of
the market-map tree with `›` at a 24px indent per depth, ending on three fixed 80px
mono lanes (COMPANIES · MEMOS · TERMS, caps heads in the section's link slot, ink when
nonzero, a dash when not); the Mandate's facts are a
one-column property grid under the head (stages as badges with the unselected ones
dashed, geographies as square chips with an inline add, the check size as mono inputs)
above the prose. Every row
ends on a fixed mono lane (`LedgerFigure`, 64 or 80px, right-aligned). A number is never
shown alone when a median exists: `ReferenceBar` draws the value in ink, the median as a
graphite tick, the track as rule — 1-bit, no colour.

### The Record Table (signature)

The hardest-working surface; spreadsheet-grade or the audience leaves.

- **Rows:** one `--row-h` (36px) shared by header and body; rules between rows.
- **Header:** 32px, sticky, paper, sentence-case sans 12 labels in graphite
  (2026-10-25). Header cells are buttons: the menu carries Sort A→Z / Z→A, Clear, Hide;
  the sort direction reads as a mono arrow after the label; the chevron appears on
  hover. Hairline under the head.
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

One implementation, `Badge` (`apps/web/src/components/ui/badge.tsx`), since 2026-09-19
(SPA-22). It takes **the option row and its index**, never a colour the caller
resolved: `optionColor`'s index fallback is what lands the board, Today and the
registry on the same hue for the same stage, and a set defined before the palette
existed still renders fully coloured. Two states drop the hue and are the primitive's
to draw, not each caller's:

- `archived` — struck graphite on bone. The treatment had been redrawn at four sites
  and had drifted at three of them; it is a prop now.
- `unselected` — a dashed rule in graphite, the Mandate's unpicked stages.

Renders a `<span>`; `asChild` wears a button or a link instead, which is also what
turns on hover (opacity), press and the reticle — a badge that cannot be clicked gets
no states it cannot use. The one badge the instrument colours for itself (`unpriced`,
`Outside mandate`) names amber as a stored colour rather than spelling
`bg-[var(--badge-amber)]`, so it goes through the same primitive as the data-coloured
ones.

### Navigation — the chassis

232px of bone with a hairline right edge. Four groups: the work (Today, Tasks, Spaces
with up to five starred spaces under it, then `▸ n more`), the library (Notes, Files),
the objects (Companies, People, Deals, then customs — three, then `▸ n more` inline),
capital (Portfolio, Mandate) — one list (`NAV_ITEMS`), read in the same order by the
command palette and the keyboard sheet, so the chassis is where nav order is decided.
Library, Objects and Capital are headings that fold (`▾` / `▸ n`), per browser; a star
is toggled from the space head's `···` and kept per browser too. Rows are 30px with a
14px mark slot so every label sits on one lane. The current row is a hairline box on
paper inside the chassis, stopping short of its edge — never a tab cut through it, never
a pine bar — and every row carries the same box, so nothing shifts. The head row ends on a
mono `«` that folds the chassis (`⌘\`). The foot is an Ask row (`⌘J`) above one account
row (ink initials square, name, email) with Settings (`G ,`) as an icon button beside
it; its menu opens to the right of the chassis — never up into the corner — and holds
Keyboard and Sign out. Collapsed, the chassis is 48px of
marks only: the mark on a hairline (which expands it again), `⌘K` on a rule, 36px rows
with a 24px rule between groups and no headings, the current page in a 36×32 paper box
on a hairline,
names on hover as ink tooltips. Width snaps (never animates) and the preference is per
browser. Collapses to a drawer under a 48px top bar on mobile.

**Sidebar A** (decided 2026-10-08, amended by D68 on 2026-10-09; port: project 27).
Ported by `shell-1` except the Ask and Meetings rows, which their slices add, and
an object's pinned saved views and the count on Tasks. The decided order:

- **Search** (`⌘K`) at the top; **Ask** (`⌘J`) is a foot row above the account row
  (amended 2026-10-25); chats live in Ask, never in the sidebar.
- **Today, Tasks, Spaces** at the top. Spaces lists starred spaces under it (five, then
  `▸ n more`).
- **Library ▾**, a collapsible group: Notes (`G N`), Meetings (`G E`), Files (`G L`).
  Documents is renamed Files and keeps its chord. Collapsed, it reads `Library ▸ 3`.
- **Objects ▾**: the objects, then customs, overflowing inline as `▸ n more` (never a
  dropdown); an object's pinned saved views sit under it.
- **Capital ▸**: Portfolio, Mandate.
- **Counts only on Tasks.** No other row carries a number. The count is ink, and
  destructive only when a task is overdue.
- **Review is not a row**; Today's Needs-you ledger reaches it (D79).
- **Upload and Settings leave the list.** Settings is the account row's one icon
  button; Upload lives in ⌘K, on Files and in the first run (amended 2026-10-25).
- **The workspace head opens a menu:** General, Members, Invite a member…. The phone
  drawer prints no key hints.
- **The current row is a hairline box on paper** (`border-hairline`), expanded and
  collapsed. Decided by the owner 2026-10-10, reversing this sheet's tab cut into the
  page edge. Still never a pine bar.

### Record Pages (P7)

`RecordHeader`: mono caps breadcrumb (`DEALS / 7C335C4A / OPENED 2026-07-29`), two verbs
and a `···` with keys in tooltips (contract §1, A4), a 28px mark (1-bit dither
tile, or ink initials for a person) beside the serif name and a square badge, then a
56px readout strip of the numbers that matter. Body left: the property grid (two
columns, hairline top and bottom, rules inside, 120px caps labels — three columns
truncated their own labels at 1440 and went 2026-09-30), then Notes, Interactions,
History and Files as sections, and Context as a head with a `show ›` and nothing under
it until asked. Rail right on bone (360px): the stage stepper (one 8px segment
per live stage, pine to the current one, hairline after), tasks, people. The rail is
sticky; the body scrolls. Deals, companies, people, custom records, holdings and spaces
share the parts.

**Decided 2026-10-25** (D74 amended; port: project 30). The record reads as the canvas
drew it; `docs/design-contract.md` §3 "A record" carries the whole anatomy.

- **Head:** the stamp alone on its row, the kind only; the mark, the serif name and its
  suffix with `[verb] [verb] [···]` on the next; the double rule; **no readout strip**.
- **Rail left**, 300px on bone: the attribute grid (bone label cell, paper value cell)
  and the relations. **Tabs right:** Overview · Notes · Interactions · Files · History,
  Overview first and the default every time, which holds the readouts that have a value,
  the open tasks, the latest threads and the latest files.

- **A space (2026-09-16).** The head measures it — SUBSPACES · COMPANIES · IN PIPELINE ·
  MEMOS · TERMS (own `+inherited`) · REFERENCED — under a crumb of ancestor links. Body:
  FILED HERE (serif memo blocks, composer `N`), COMPANIES as the market map (1-bit mark,
  stage badge, a mono `n deals` / `watching` lane, geo, hover `×` untags with an Undo
  toast; the composer row is an inline name search that tags on `↵` and stays open for
  the next), RECORDS, GLOSSARY. Rail: MAP (`↑` parent, subspaces with their telling
  count, `+ Subspace` inline), REFERENCED (mentions filed elsewhere), Tasks. Tracking is
  not evaluating — a company can sit here in no pipeline at all, and the lane says so.
  **Decided 2026-10-08** (D73, D74; port: project 27): a space reads like a record.
  - Head: the `SPACE depth n` stamp, the serif name with its crumb, Note here (`N`), and
    a `···` menu holding Rename, New subspace, Move to…, Save as template… and Archive.
  - Three readouts only: in pipeline, last filed, and the funding-stage mix as a dither
    bar (the page's one dither moment). Counts live on the tabs.
  - Details column: Map (parent, subspaces, `+ Subspace`), Glossary, Tasks.
  - Tabs: Companies · Notes · Files · People · Records, Notes by default; Referenced
    folds into Notes as a filter (Filed · Mentions); an empty tab stays grey at 0.
  - Archive asks nothing, because Restore undoes it; the archived page shows the outline
    stamp and one notice of what still holds. Move to… is a window that greys the space
    and its descendants.
  - **Amended 2026-10-25** (D73 amended; port: project 30): the head is `···` alone
    and the stamp prints no depth; Overview is the first tab and the default, holding
    the three readouts, What's moving, open tasks and the latest companies; the rail is
    Criteria, Watching and Map; Glossary… and Sensitive move into the `···`.

- **The Ledger.** Three lanes on rules — the mono day (`13 Oct`, the time in a tooltip),
  mono caps type (`CALL · STAGE · FILE · EDIT · BORN · INVEST · MARK`), sans body.
  Attribute bursts expand in place. Since 2026-09-30 it is two sections, not one list: **Interactions**
  (calls, emails, meetings — each with its `Write up` / `Open note`) under the composer
  row, and **History** (stage moves, edits, filings, the portfolio's verbs) folded past
  six rows behind `+ N more`. A call and `tagged into a space` never again share a lane. An
  interaction row is two lines (2026-10-05): the subject with its badges, mailbox or
  artifact marks and RSVP; then, in graphite, who took part and the ✦ summary.
- **Notes** is one list: filed rows first, then the notes that merely mention the
  record, stamped `mention` in the mono end lane. Empty is `No notes.`; the way in is
  `note about this ›` in the head.
- **Files** owns its head — `N files · size` and `upload` — and draws the dashed
  dropzone only while the list is empty or a drag is over it; once files exist the rows
  are the section and the whole of it is the target.
- **The Composer Row.** Adding to a stream never starts from a corner button: a 40px
  row with a pine `+`, graphite hint text and the key that opens the real dialog
  (`+ Log a call, meeting, or note…  L`). The Tasks page grows it into the bone
  composer band (P6): paper input, square chips, create-more switch, `Add task ↵`.

### The Board (P4)

224px columns whose head is a mini readout strip — square stage badge, count, Σ,
median — on a hairline. Paper cards on rule borders: 1-bit mark + name, `company ·
check` mono with days in stage (crimson past 2× median), `close 13 Oct · Nd` with the
owner's initials. A dashed `+ N more` folds long columns; a pine dashed `drop →
Stage` box appears while dragging over a column.

### Overlays (P8)

- **The attribute sheet:** 660px, two panes under the 48px head (`New attribute` ·
  mono `on Companies · 19 → 20`): a 236px type pane on a rule with the pine `›` search
  and 26px rows (mono glyph lane, label, the chosen row on bone), the form right (name
  with its frozen mono slug beneath, description, the per-type slot, default and
  required on one line), the bone foot saying where it lands. In edit mode the pane
  stays, greyed — the type is the record of what this is.
- **Dialogs:** paper sheet, 1px ink, 3px solid shadow, 0 radius. 48px head on bone —
  serif title 18/600, mono context beside it, hairline under (bone since
  2026-10-05); no `esc` and no cross in the head (2026-10-06). 20px body on paper.
  52px bone foot — Cancel beside the primary, its key in the tooltip; one close per
  dialog. The first field takes the reticle on open. Four sizes (2026-10-25): S 440 for
  a confirm or one field, M 560 for a form, L 768 for a reading window, the file viewer
  1152; a window opened from a window steps down under its parent, one stacked at most.
  The quick task has no title bar — the input is the title. A modal must be argued for.
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
- **Confirm:** 440px. The 8px crimson square and the serif question sit in a bone head
  band (2026-10-05); under it on paper, one sans sentence saying what happens and what
  does not, an optional rule-bordered
  ledger of what is affected (name left, mono meta right), then the bone foot: Keep
  takes focus, the destructive button carries ⌘↵. `useConfirm()` replaces
  `window.confirm` everywhere; a confirm exists to be read, never to be clicked through.
- **Menus / pickers:** paper, 1px ink, the dithered shadow, 28px rows, highlighted row in
  bone, 150/100ms.
- **Command palette:** one fixed size (2026-10-25),
  `min(1060px, 100vw−2rem)` × `min(560px, 100dvh−4rem)`, with every state — empty,
  typing, no results, loading — in the same box and the preview pane always mounted; a
  pine `›` prompt, `↑↓ move · ↵ open` on the right, caps group labels, 32px rows, the
  `↵` hint on the highlighted row, a 32px bone foot.
  With an embedding model pinned, a second query with the meaning lane runs 600ms after
  the last keystroke and replaces the list — no spinner, no entrance, and never once
  the selection has moved or ↵ is pressed (SPA-129). A row found by meaning alone
  reads `· meaning` in its mono lane, and its snippet is a plain cut with nothing set.
  Decided 2026-10-08 (D70 amended; port: project 24/27): the palette **finds only**.
  It has no answer stage; Tab hands the typed query to Ask. Nothing typed shows the
  page's own actions, a highlighted passage previews its page, and an action that needs
  one more answer asks it in the same palette. With nothing previewable highlighted the
  pane is blank bone.
- **Ask** (decided 2026-10-08, D70 amended; port: project 24). A docked 408px third
  column beside the page, and a full `/ask` page with the thread list, both over one
  thread store. Answers are sans with ref chips; action cards propose and the person
  applies; the context in scope is shown as chips and frozen per turn. The scope chips
  sit in the composer, and a citation previews its passage on hover (2026-10-25).
  - The panel closes completely (⌘J or ×, no rail) and resizes from its left edge,
    360–560px, remembered per browser.
  - `/ask` reads in a 760px column with a collapsible thread list; tables break out to
    the full content width (in the panel they scroll inside their card).
  - Your turn is a right-aligned bone block with a hairline, at most three quarters of
    the column; the answer has no box and sits left at full measure; a scope change is
    a centred mono divider.
- **The keyboard sheet:** `?` opens it (the account menu lists it). Two columns of 26px
  rows on rules — Go, Create, On a deal, In a sheet — with 18px keycaps (hairline, 2px
  foot, mono 10). Only keys that work are printed. Every nav row prints its G-chord in
  its right lane; chords wait 800ms and every key is off while typing. Documents takes
  `G L` (library, the shelf) because `G D` is Deals and L was the one free letter that
  says what the page is; it keeps `G L` as Files.
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

Decided 2026-10-09 (D80; port: `first-run-1`):

- **Today's empty state is the onboarding.** An empty workspace's Today offers three
  ways in: Import a file, Drop a deck, Add a company. It goes away once data exists.
  There is no checklist and nothing to dismiss.
- **A missing setup is named where it is used.** A feature whose key or connection is
  absent says so in place with one link (`Ask needs a model to answer · Add a model ›`,
  `No calendar connected · Connect Google ›`). A member sees who to ask instead of the
  link.
- **The whole picture is passive:** Settings → General → What's set up, never shown
  unprompted.

### Settings

The section pattern: serif title 18, one sans sentence, a mono crumb (`SETTINGS /
CAPITAL`) right, hairline under; then 48px rows on rules with the control on the right.
Tables inside settings use the ledger primitives unchanged — the FX rates ledger is the
example.

**Settings by whose it is** (D81, decided 2026-10-08/09; port: project 27). Until the
port, the shipped nav and pages stand; build toward this:

- **Settings takes over the sidebar**, with `‹` back. Four groups, by whose it is:
  - **You:** Email & calendar, Files, Meeting notes, API tokens. Accounts are grouped by
    the job they do, never by provider.
  - **Workspace:** General (logo, name, base currency, What's set up), Members, Objects,
    Templates, Currency & FX.
  - **AI:** Models (the sensitivity floor at the top, providers, who does what),
    Search (embeddings; reuses the Models key), Usage & limits.
  - **Integrations:** Connections, Plugins, Enrichment (D76), Email forwarding
    (amended 2026-10-25: Connection apps folds into Connections).
  - The nav's group heads are ruled bands: mono caps in ink with a hairline under, the
    grammar the settings ledgers' heads use (2026-10-25).
- **One way to save.** Toggles and selects apply at once with a toast. Typed fields
  collect into one Save bar at the foot of the page, shown only while something changed.
  No per-section Save.
- **Confirms on four acts** that break something outside the page: revoking an API
  token, suspending a member, archiving an object, unticking an identity key. Reversible
  toggles stay instant.
- **A member sees admin pages read-only**: the page with its controls disabled, keys
  redacted, and one line naming who can change it. No "Admins only" page.
- **No footer caption strips.** A line survives only for cost, privacy or
  irreversibility, beside its control.
- **Every plugin and every account has its own page.**
  - A plugin page is one template: status and version, the workspace key, what it
    sends, its manifest settings, what it switches on (linking to the page that owns
    each capability, never repeating its settings), recent runs and errors, Disable /
    Uninstall.
  - An account page (Options ›) holds the person's choices for that account, last sync
    and Disconnect.
- **Plugins is a catalogue:** Installed as a ledger, then Available from the registry
  under tabs by job (Enrichment, Research, Email & calendar, Files, Meeting notes,
  Import, Feeds).

An object's attributes are a settings ledger too (2026-09-11): a caps column head on a
hairline — ATTRIBUTE · TYPE · CONSTRAINTS · ORIGIN · ORDER · EDIT — with the lanes shared
by head and rows so they stay one grid; rows on rules with a `⋮⋮` grip lane, the name
with its description under it, the raw type slug in mono, a mono constraints lane
(option count, target, currency, out of n, required, default), a caps origin tag (system
on bone, custom on the selection wash), and always-visible `↑ ↓ ✎ archive` marks in
graphite. Select rows carry their square option badges beneath, archived options struck
on bone. Archived attributes fold into a collapsed
ARCHIVED section with a Restore button and no grip. `A` opens New attribute.

## 6. Do's and Don'ts

### Do:

- **Do** keep the data field paper and the chassis bone; let ink, pine and type carry
  all character.
- **Do** set every measured thing in mono, and every comparable figure `.numeric`.
- **Do** hold body text at ≥ 4.5:1 — graphite is the only second text colour.
- **Do** put a working key in its control's tooltip, the `?` sheet and Cmd-K when the
  binding is ours and not guessable (`⌘↵` from a field, `L`, `G T`) — never inside the
  button; `esc` and `↵` are never printed.
- **Do** use density confidently in the ledger; calm comes from rules and rhythm, not
  sparseness.
- **Do** print a hint only where a wrong choice costs credits, privacy or something
  that cannot be undone. Everything else is a tooltip or the docs.
- **Do** spend each printed detail inside its budget: one double rule, one stamp, one
  dither moment per region.

### Don't:

- **Don't** draw a pine bar on any edge — the No-Bar Rule. Current, selected and
  highlighted have their own treatments.
- **Don't** blur a shadow, round past 2px, or make a pill or a circle.
- **Don't** put dither under text, move it at rest, or give it a third colour; the
  Twinkle is the one moving dither, and only while something works.
- **Don't** set a name or a sentence in mono, or a number in sans.
- **Don't** use color decoratively. No gradient text, no side-stripe borders, no
  glassmorphism.
- **Don't** animate for decoration. Motion conveys state; no entrance choreography,
  nothing over 250ms.
- **Don't** reach for a modal first. Inline and progressive disclosure are the defaults;
  modals are the exception that must be argued for.
