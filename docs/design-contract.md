# The design contract

Instrument is the design of Spaces, and this file is its one rulebook: what the system
is, the vocabulary you may spell, the primitives that already exist, the precedent every
new surface copies, the line between what lint enforces and what a reviewer judges, and
what is decided but not yet built. Read it before writing tsx.

Values live in `apps/web/src/styles.css`; that file decides, this one names. `DESIGN.md`
at the repo root carries only the tokens, as front matter for design tools, and points
here. `docs/product-map.md` tracks which surface is drawn and built, not how it looks;
`docs/decisions.md` holds why. Where this file and shipped code disagree, one of them is
a bug: say which in the PR.

---

## Instrument

**"Instrument, printed": a measuring instrument for capital, and the sheet it prints.**
Paper for the data field, bone for the chassis, one ink for structure, one LED (pine)
for the action. Everything the instrument measured (money, counts, dates, durations,
IDs, domains) is mono, because a reading is a reading; everything a human wrote (a
company's name, a page title, a thesis) is serif, because a person named it; sans
carries the interface between them. Density done the Attio way, speed felt the Linear
way, character carried by type and material, never by the surface.

It rejects enterprise CRM chrome, the generic SaaS template look (shadcn defaults,
gradient heroes, purple accents, identical card grids) and the dark terminal aesthetic.
Mono is a voice for readings, not a costume for the whole app. Nothing blurs, nothing
rounds past 2px, nothing is a pill. WCAG AA is a floor, not a target.

The Paper canvas is the drafting table and this repo is truth. File `spaces`
(`01M19X8AY9DZD3PZMJK7RWVMTB`): Foundations, Kit and Grammar hold the library, and each
area has its own page. Open a page, find nodes with `get_tree_summary`, read exact
values with `get_jsx(nodeId, "inline-styles")`; never read a value off a screenshot.

---

## 1. The vocabulary

### Materials

Two untinted neutrals, one ink, one LED.

| token       | value                   | class                       | role                                                                                              |
| ----------- | ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `paper`     | `#FFFFFF`               | `bg-paper`                  | the data field — tables, records, dialogs                                                         |
| `bone`      | `#F4F3EF`               | `bg-bone`                   | the chassis — sidebar, rails, dialog feet                                                         |
| `bone-deep` | `#E9E7E1`               | `bg-bone-deep`              | pressed, disabled, archived rows (an archived option badge is struck on plain bone — see `Badge`) |
| `rule`      | `#D6D4CD`               | `border-rule`               | inner rules — rows, cells, inputs                                                                 |
| `hairline`  | `#1C1C1A`               | `border-hairline`           | 1px structure — sections, sheets, the edge                                                        |
| `graphite`  | `#5C5B56`               | `text-graphite`             | the second text colour, and the only one; 5.9:1 on paper                                          |
| `ink`       | `oklch(0.24 .012 155)`  | `text-foreground`           | text, 13:1 on paper                                                                               |
| `pine`      | `oklch(0.55 .14 155)`   | `bg-primary`/`text-primary` | the LED — primary action, live segments, end-dots                                                 |
| wash        | `oklch(0.962 .022 155)` | `bg-selected`               | the selection tint, 14.8:1 under ink                                                              |

The neutrals are hex on purpose: they are the bench's materials, not points on the
brand hue; ink keeps a whisper of 155° so text and pine belong together. Row hover is
opaque bone, never a translucent tint, which would let a sticky column's scrolled-under
cells bleed through.

**Pine** (≈ `#00884B`) is the primary action, the filled segments of a stage stepper,
sparkline end-dots and the `+` that starts a composer. Its lightness is pinned by
contrast: 0.55 measures 4.52:1 under white text by proper OKLCH→sRGB conversion, never
eyeballed. Hover deepens to `oklch(0.5 0.14 155)`, 5.51:1.

**Light only, by decision.** `:root` declares `color-scheme: light`, so native controls
follow the app rather than the OS; there is no `dark` variant, and every colour is a
token (a raw colour in tsx is a lint error), so dark, when it is built, is a second
token file and not a redraw.

Semantic colour only where it encodes state: `text-destructive` (crimson
`oklch(0.48 0.17 12)`: delete, overdue, past 2× median), `text-warning` (amber
`oklch(0.7 0.13 75)`: unpriced, missing FX; as a row wash, the amber badge tint with
amber ink), `text-success` (teal `oklch(0.55 0.09 190)`, never green, because pine owns
green and a state never shares the action's hue), `text-info` (`oklch(0.55 0.1 240)`).
A readout is coloured only when its value is nonzero and bad; a zero reads graphite.

**The badge palette** is twelve hues (slate → cyan) for select, status and stage
options, each a pale tint at L 0.955 with same-hue ink at L 0.45, chroma the largest
the sRGB gamut allows; the worst pair measures 6.26:1. An option gets a hue
auto-assigned and a person can override it.

**Material and scale.** Radius is `rounded-md` (2px) on controls and
inputs, `rounded-none` everywhere else — no 4, 6, 8 or 12, no pills, no circles.
Shadows are named by kind and chosen by the primitive: a popover `shadow-dither` (4px,
Bayer 8/16), a window over the scrim `shadow-solid` (3px ink); a call site passes none
and gate 5 refuses `shadow-[…]`. Nothing blurs. Spacing is 4 8 12 16 24 32; the
page edge is 24 and the body gutter 12 (The edges, below). Heights: table row 36 (`h-row`), ledger row 40 (`h-ledger-row`),
section head 44, tab bar 44, control 32, `Band` 28, `Segmented` 28, small 26, a row's `···`
24, badge 20, nav row 30, dialog head 48, dialog foot 52. The readout strip (56–64) stays
for Today and the holding's figures only; a record's readouts live in its Overview tab.
The record table keeps 36 because it is a spreadsheet and density is its job; every
ledger is 40. Structure is 1px ink (`hairline`) for sections, sheets and the chassis
edge; `rule` for rows, cells and inputs; 2px ink for the reticle. A card sits at 0 on
its rule, a popover and a window lift as above, a toast is ink. Initials sit in ink
squares, never circles. The only texture is dither (the Dither Rule).

### The edges (2026-11-11, drawn on the Paper page "Edges options", boards D)

How a page meets its frame, and how its parts rank. Decided by the owner on the canvas
on 2026-11-11, in place of the 12px edge and 4px gutter of 2026-11-07. `edges-2` built
the frame; `record-1` built the inside of the record's rail from Paper board "18
Company record · details column", the rule for every record kind; `settings-1` built
the settings pages.

Where it lives. `PAGE_EDGE` (`px-6`), `PageBody` (bone, `p-3 gap-3`, `flex-1`),
`FolderGround` and `Card` are in `components/page-header.tsx`; the ground itself is the
app shell's `main` (`routes/_app.tsx`, `data-ground`), bone on every page, settings
included, with each page filling its height. `styles.css` holds `--inset` (24px on the page, 11px
in the `card` and `folder` utilities), the `card` utility (paper, 1px rule, its opening
`SectionHead` turned paper), the `folder` utility (paper, hairline sides and foot, no
top) and `tab-open` / `tab-open-plain`. `Tabs` (`components/ui/tabs.tsx`) draws the
folder bar and, given `children`, its body; `FolderBody` is the body when the bar is
drawn apart from it (a list's view bar, Notes, Meetings, Review); `plain` is the inner
bar inside a rule card. `RecordTable`'s `folder` frames a list's table in hairline;
without it a table is a rule card. `RecordBody` (`components/record/record-parts.tsx`)
is the record chassis. On a page that scrolls the head folds; its bar sits on the 24px
edge and its pinned actions end where they ended unfolded — the 24px edge, or a settings
page's 800px column (E4) (`components/head-fold.tsx`).

- **E1 · The content edge is 24px.** The page title sits on it, and so does every
  card's content: the body gutter is 12px, a card is a 1px box with 12px between cards
  and an 11px inset, so 12 + 1 + 11 lands card content on the 24px line. The space
  outside a card is never smaller than the inset inside it. A note editor keeps its
  own margin inside its sheet (`NOTE_INSET`, §3, "A note"); its head stands on the
  edge like every other.
- **E2 · One ink line under the head.** A single 1px ink line (`border-hairline`), never
  the double, and the head is paper on every page; a line inside the head and between
  rows stays the rule. An index page's head is 48px (D114): the title at the head step,
  any mono notice on its baseline, actions at 32px, never folded, pinned from `md` where
  the page scrolls. A page about one thing keeps the 104px head; on a page that scrolls it
  folds to the 48px bar
  with its tabs and toolbar pinned; a list page, and a tabbed record or a space at `xl`,
  is a fixed pane and never folds (D106); below `md` a list scrolls with the window, its
  head scrolling away and its column head sticking under the top bar. The `···` is the rightmost head control and its right edge
  lines up with the last control in the content below. The 104px head's title
  (`title-serif`) is 28 on 32 from `md` up and the page step, 22 on 28, below it.
- **E3 · Windows take one 16px inset all round.** Every line in the head, the body
  and the foot starts on the same 16px line. A padded window's rows inset nothing more
  (`--inset` is 0 in a window); a `flush` window (the note, the viewer, Cmd-K) and a
  region that runs to a padded window's edge (`window-bleed`) inset their rows 16px. A
  row's leading mark (a kind icon, a checkbox) stands on the line, its text after it;
  a bordered control (an input, a rule-bordered list or notice) stands its edge there.
- **E4 · Settings and form pages cap at 800px**: a column of cards 800px wide from the
  gutter, 12px apart, under the shared head, whose action (and `···`) ends where the
  column's content ends (`SETTINGS_HEAD_CAP`); the Save bar sits on the 24px edge under
  the same cap. Lists and tables stay full width. Prose caps its measure and sits left,
  never centred: a memo, the mandate or a glossary definition under `max-w-160`, the
  note editor at 72ch, Dedupe's wide body at 880px. A settings row opens Edit as a whole,
  and its actions are always visible, never hover-only: a settings row carries no
  `data-row`, so no `row-reveal` hides them.
- **E5 · Folder tabs.** The open tab has an ink outline on top, left and right and
  runs straight into the body under it; a closed tab is plain text. The list toolbar
  is tabs · a divider · Filter and Sort as icon buttons, each outlined only while in
  use and then reading its state (`Filter 2`, `Last contact ↓`); search alone on the
  right with its `/` hint, ending on the table card's right edge; Columns is an icon at the end of the column-head row. Save
  view appears only with something to save: `Save as view…` on a filtered All,
  `Update view` + `Reset` on a changed view; `Save as new view…` lives in the view's
  `···`. Tables keep their column lines and white column heads.
- **E6 · Every create is `+ New x`, in pine.** The split `[+ New x | ▾]` only where
  creating is instant and templates exist (Notes, Spaces); at the right end of a
  tab's toolbar (a record's Notes tab) it is the bordered secondary, as Files' `Upload`. Files' create is `Upload`;
  Portfolio's primary is `Record a check`. A window's confirm carries no icon.
- **E7 · One icon per verb, Carbon first**, from one shared icon list; a custom SVG only
  for our own concepts (the note kinds), drawn on Carbon's 32px grid. Brand marks only
  through `ProviderMark`: the brand's official logo in its own colours (Simple Icons where available, the brand's own multi-colour logo where that is the one people know, else the brand's app icon served from the app itself), the one place colour other than the tokens appears.
  Two sizes: 16px (Carbon's own size) in rows, menus, tabs, buttons and a rail, a brand mark
  included; 20px for the one mark that leads a window's head or an empty state. Never 12px or
  14px: Carbon's line goes soft below its grid.
- **E8 · A date band carries no count.**
- **E9 · The ground is bone, the sheets are paper.** Under its head a page's body is
  bone, and every card on it is paper: material separates a sheet from the desk before
  any line does. The head stays paper. Bone inside a card is a group band only
  (`Band`, a `SectionHead` inside a folder); a card's own head is paper, 44px with a
  sentence-case title for a section card or 28px with a mono caps label for a small
  one, a rule under either.
- **E10 · One ink object on a page: the folder.** The page's tabbed object — a list's
  table, Today's Needs you, a record's tabbed pane — is a folder: its tab bar sits on
  the ground, the open tab is paper, and the body under it is paper in a hairline
  frame that the tab joins. Every other card takes the rule. A page with no tabs has
  no hairline card. Where a page has two tab bars, the page's own is the folder.
- **E11 · A record's rail sits on the ground.** No card and no border: its rows are
  printed on the bone at the 24px edge, and the folder stands to its right. The rows
  themselves are a 104px label lane and a value on a rule, never a boxed grid; a long
  text attribute is a paragraph in Overview, and a relationship shows once, as its
  section.
- **E12 · Every menu item leads with its 16px mark.** A fixed 16px lane, 8px before the
  label, on every item of every menu and picker, never on some: a verb's Carbon glyph from
  the shared list in graphite (the same glyph for the same verb everywhere), a service's
  own mark through `ProviderMark` when the item goes to that service (`Attach from Drive`,
  `Open in Gmail ↗`), a thing's own noun when the item is a thing (a file's page, a
  folder's folder, a record's kind). A destructive item's glyph is destructive with its
  label. The label keeps `…` for a window and `↗` for leaving; keys stay in tooltips.

### The named type steps

One family in three cuts, IBM Plex Sans, Serif and Mono at their default letterforms,
self-hosted through Fontsource as static weights 400 to 700: a privacy product makes no
font CDN calls. Eight steps, fixed rem, never fluid. The list is the `--text-*` custom properties in
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
| `head`    | 17 / 24        | an index page's title, 48px head    |
| `page`    | 22 / 28        | page titles                         |
| `display` | 26 / 32        | record names                        |

Three sizes sit outside the steps, each carried whole by a utility: `title-serif` (the
page step below `md`, 28 / 32 from `md` up), `label-caps` (mono 11 / 16, 500, 0.08em
caps) and the prose register, serif 17 / 27, for note bodies, theses and reasons
(`styles.css` names it beside the editor).

**An unnamed size does not ship.** `text-[…]` and `leading-[…]` are rejected by
`instrument/vocabulary`, which names the nearest step in the message; the only way
onto the list is `apps/web/src/styles.css`. A genuine optical one-off (initials inside
a 16–22px square) takes an inline comment saying why plus a scoped disable.

Utilities that carry a step whole: `title-serif`, `label-caps`, `field-label`, `mono`,
`numeric` (tabular + right-aligned in one class), `tabular`.

### The three voices

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
graphite (`LedgerFigure`, and the board card's `company · check`).

**Who wrote it decides the voice** (D78). A note a person filed from a tool (a Granola
note in a ticked folder) is serif with a mono `via <tool>` mark: the person chose to
file it. Text a model wrote that nobody chose is sans: an Ask answer, Exa's brief, an
unfiled summary.

### The Casing Rule — three tiers

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

### The Separation Rule

A page reads as stacked sections. Every section separates itself by at least two of
**material**, **space** and **ink weight**, and the shared primitives draw it
(`SectionHead`, `LedgerSection`, `RecordSection`, `SettingsGroup`, `LedgerRow`,
`DialogHeader`, the confirm), so a surface built on them follows:

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
- **Surface.** Paper is work, bone is frame, bone-deep is pressed. A record's
  attribute rows are printed on the bone ground of its rail, no cell of either.
- **Line.** One ink line under every head (E2); ink is structure; a rule separates inside
  a pane; space separates inside a group.

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

### Kinds

Where a row, a chip or a picker names a record of mixed kinds, its kind is a leading
icon, never a word: the one map from the shared icon list (company `Building`, person `User`, deal
`Column`, space `Layers`, note `NoteKindIcon`, document `Attachment`) and a custom object's
own `objectIcon`, with the kind word as its tooltip and `aria-label`. Never the icon
and the word side by side. A word stays where the word is the data: a stamp (`MEMO`),
a state word, a table cell. A custom object with no chosen icon prints its word. A group that already names its kind (a
record's Team, Associated deals) needs no icon on its rows.

### The seven rules

**The Meaning Rule.** Colour only encodes: action, selection, state, stage, status. A
colour that cannot name what it encodes is forbidden.

**The Two-Tier Rule.** Pine is the only fully saturated fill on a surface. Badges are a
pale tint with same-hue ink, square.

**The Numeral Rule.** Every measured thing is mono: money, counts, dates, durations,
IDs, domains. Prose, names and column labels never are. Comparable figures are tabular
and right-aligned, one class (`numeric`); figures inside a sentence take `tabular`.

**The Reticle Rule.** Focus is four 2px ink crop marks 3px outside the control
(`focus-ring`), inset inside a scroll container (`focus-ring-inset`). Never pine, never
a ring.

**The Dither Rule.** Dither is 1-bit, pine or ink, Bayer 4×4 at 2px cells. Never under
text, never moving at rest, never a third colour. **Dither is data**: a chart, a
readout's history, a 1-bit fallback mark, a space's funding-stage bar, an empty page's
noun and a popover's shadow (`shadow-dither`; a window is solid, `shadow-solid`). One
dither moment per region; a section head, a button or a page background never is. The
one animated dither is the `Twinkle`, a 4×4 grid stepping in Bayer order, for a working
state only: a spinner never ships, and loading is a density ramp, never a shimmer.

**The Contrast Floor.** Body ≥ 4.5:1, graphite 5.9:1, no sub-100% opacity text. Key
hints on pine are the one exception, at 85% and still ≥ 4.5:1.

**The No-Bar Rule.** Pine never appears as an edge bar. The current nav row is a
hairline box on paper; a selected row is wash + check; a highlighted option is bone; a
winner is ink against graphite.

### Motion

Pure CSS, used extensively, never decoratively. No JS animation runtime: Radix
`data-state` attributes, `tw-animate-css` keyframes and Tailwind transitions carry
everything, which is what lets the one global `prefers-reduced-motion` query silence the
whole app.

- **The Compositor Rule.** Animate `transform` and `opacity` only, never width, height,
  top or margin; a motion that can't be said in those two doesn't ship. It holds inside
  controls too: a switch's knob travels on `translate-x`.
- **Every transient surface enters and exits**: fade plus a slight scale (0.95 → 1),
  from its trigger (Radix's placement origin), never from the screen's centre.
- **Exit is faster than enter, and frequency scales the numbers.** Dialogs and the
  palette 180 in / 120 out, menus 150 / 100, tooltips 120 / 80, cell edits and hovers
  ≤100ms or nothing, all on `--ease-out-quart`. Nothing over 250ms.
- **Interruptible, never blocking, no load choreography**: a page appears settled.
- **A press is physical**: a button compresses to `scale(0.97)`; no bounce, no springs.
- **Composer add.** A row a composer just created lands on a bone wash that fades over
  250ms (`row-wash`, `LedgerRow`'s `wash`). Who created it decides, never its age:
  `useBornRows` grows only when a composer reports the id its write returned, so a list
  the loader filled washes nothing.
- **A refused field edit** snaps back to the stored value and the cell holds crimson in
  place for 2s, a pane over the cell rather than a border, so nothing moves; it leaves
  on opacity over 120ms (`rejectPaneClass`). The hold is a state, so it survives
  reduced motion.
- **Row exit.** A row that leaves because you acted on it strikes through and fades over
  150ms, the write held until the transition ends; it keeps its height until it
  unmounts. An irreversible-feeling exit pairs with Undo in the toast; a truly
  irreversible one (delete) asks first.
- **Toast** rises 8px as it fades in, 180 / 120ms, sonner's own slide overridden.
- **A pending button** disarms, swaps its label (`Save` → `Saving…`) and holds the width
  it had armed (No-Shift). No spinner.

`micro-interactions.test.ts` reads the stylesheet and the class helpers and holds these.

### Interaction engineering

The floor under the look, vendored in full as the `design-engineering` skill; where
the skill and this file disagree, this file wins.

- **The No-Shift Rule.** Dynamic content never moves its neighbours: fixed dimensions on
  async slots, tabular figures on changing numbers, and **weight never changes with
  state**; hover and selected speak through colour and the wash.
- **Name your transitions.** `transition: all` is banned.
- **Hover is an enhancement.** Nothing needs hover to work; Tailwind gates `hover:`
  behind `(hover: hover)`, never undo it. Controls take `touch-action: manipulation`; on
  a coarse pointer an input renders ≥16px (iOS zoom) and a hit area reaches 44px even
  when the visual is smaller.
- **Keyboard parity.** Tab reaches only what is visible (`inert` the hidden), keyboard
  focus scrolls into view, Enter submits a form, Cmd/Ctrl+Enter a textarea or a dialog,
  an icon-only button carries `aria-label`. Bare-key shortcuts (`useHotkey`) are off
  while typing and inside dialogs, and each is in its control's tooltip, the `?` sheet
  and Cmd-K (A2).
- **The z-index scale.** sticky 150 · modal 200 · dropdown 250 · tooltip 300 · toast
  400, as `z-sticky … z-toast`, and no other values. A menu sits above a modal because a
  picker opened in a dialog floats over it. Prefer `isolation: isolate` to climbing (the
  record table isolates its sticky head and pinned column).
- **Virtualize past ~200 rows.** A ledger stays dense by drawing less, never by
  paginating (checklist 17 says where that stands).

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
are shown by their own mark at 16px (E7), never a monogram; degraded is the same mark at
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
  button. A `···` that would hold one frequent verb is that verb as the outline
  secondary; a rare verb stays in the `···` even when it is the only one (A7).
- **A2 · No key is printed inside a button.** A key lives in the button's tooltip, the
  `?` sheet and Cmd-K. Keys print on the surface only in a composer row's end lane and
  in the sidebar lane, where they are the row's data. Keyboard parity holds the
  same line.
- **A3 · One act has one control per surface, and one label everywhere.** If a section
  has a composer row for a verb, the head does not also carry it; the key focuses the
  composer. The label is the same on every surface (`New task`, never `Task` /
  `Add task`).
- **A4 · A record head is `[verb] [verb] [···]` on every kind.** The verbs are the two
  most frequent for that object; Sensitive, Save as template, Copy link and Archive
  live in the `···`, which every record has. Before the verbs stand two quick icons,
  New note and New task, icon-only and outlined, keys in their tooltips; each opens its
  window over the record, already filed on it. Navigation is a link in the title or
  the crumb, never an outlined button.
- **A5 · A row ends on a mono lane and a bare `···`.** The lane holds the row's figure
  or state word; the `···` appears on hover; the row itself is the link. No word that
  would read the same on every row (`void`, `record mark ›`, `raised`), and delete is
  never a bare icon.
- **A6 · A dialog foot is `note? · Cancel · Primary`.** Cancel is outline, the primary
  is filled, neither carries an icon or a printed key. There is one commit; a variant
  is a toggle beside it. The note is for cost, privacy or irreversibility only, and it
  wraps rather than truncates. A window with nothing pending to cancel ends on `Done`
  instead (D108); the email window's foot is `Done · ··· · Reply`, its note saying who
  reads the email only when that is not the default (`Shared with the workspace`,
  `Shared by Priya Raman`) (D109).
- **A7 · State is never a control.** No disabled button or menu item announces a
  missing setup; a `···` with no enabled item does not render; a menu of one frequent
  verb is that verb as a button, while a lone rare verb stays in the menu
  (`forceMenu`); a toggle shows its state as a switch, not as its label. Where
  something is missing, the place it would be used carries one link to fix it (D80).
- **A8 · A number prints once per screen.** The title or the tab carries a list's
  count, not both; a readout never repeats a section count and a section never repeats
  a readout; a row prints a date or an age, not both.
- **A9 · A create window asks only for identity.** Name plus the identity key (domain,
  email); everything else is `More fields ›`, inferred (company from email, deal name
  from company and stage, date today) or filled later by enrichment. Focus lands in the
  first field.
- **A10 · One tab bar shape, and it hides when there is one view.** Folder tabs on
  white (E5) in sentence case, a count on every tab that holds something and none at 0;
  the toolbar E5 describes; a nested switch is a bounded `Segmented`; a second axis is a
  chip in the bar, never a second row; the bar is absent when there is a single view.

Three more rules govern what a section or a list prints rather than how it is acted on.

- **H1 · An empty section is one `Name +` row.** The name in graphite and a `+`, with
  no sentence, no composer and no 0. The absence sentence survives only where absence
  is news (`Nothing matches that filter.`). A record's empty Interactions tab is its
  toolbar instead: `No interactions yet` left and an outlined `Log interaction` right
  (D109).
- **H2 · You are never listed among a row's people.** The viewer is left out of the
  people lane, which prints two names and `+N` (`Priya Raman, Dev Shah +2`); a sent
  row reads `To X`. A thread row's second line is its summary (two lines in the
  Interactions tab, one elsewhere), or its file names when it has none, with the clip
  and its count at the line's right end under the day (D109).
- **H3 · A list prints the day.** The time lives in the viewer or a tooltip, and a long
  list breaks by week on bone bands. Today's rows and scheduled meetings show the time,
  because the time is what they are about.

---

## 2. The primitives that exist

Compose these. A new component is a last resort and needs the same argument a modal
needs. A row marked _decided_ is drawn and recorded but not in the code yet: it lands
before the surfaces that use it, and a surface that needs it waits rather than
hand-rolling one.

| primitive                                                                         | file                                                     | for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`, `ReadoutStrip`                                                      | `apps/web/src/components/page-header.tsx`                | P1 — paper, the serif title on the 24px edge, `[outline?] [Primary] [···]` right ending 24px in, one ink line under, 48px on an index page and 104px on a page about one thing (D114); keys in tooltips (A2), and a count only in the title (`HeadCount`) when the page has no tab bar; `tabs` stands on a pinned `FolderGround`                                                                                                                                                                                                  |
| `PageBody`, `Card`, `PAGE_EDGE`                                                   | `apps/web/src/components/page-header.tsx`                | E1, E9 — `PageBody` is the bone ground under the head, the 12px gutter round it and cards 12px apart, filling the height; a card is the `card` utility, paper in a 1px rule box whose rows inset by `--inset` (11px), so its content lands on the 24px edge, and a `SectionHead` that opens it is its paper head. `FolderGround`: the gutter and bone a folder bar stands on, pinned under the folded head                                                                                                                        |
| `NewButton`, `SplitNewButton`                                                     | `apps/web/src/components/new-button.tsx`                 | E6 — `+ New x` in pine; the split `[+ New x \| ▾]` with the templates behind the `▾` (Notes, Spaces only), `variant="secondary"` bordered in a tab's toolbar                                                                                                                                                                                                                                                                                                                                                                      |
| `icon`, the nouns, `NoteKindIcon`                                                 | `apps/web/src/components/icons.ts`, `note-kind-icon.tsx` | E7, E12 — the only icon-library import site (Carbon, D19): one glyph per verb (`icon.new`, `icon.filter`, …), nouns by name; the note kinds drawn on Carbon's grid; 16px, 20px leading a window head; every menu item's mark                                                                                                                                                                                                                                                                                                      |
| `ProviderMark`, `brandOf`                                                         | `apps/web/src/components/provider-mark.tsx`              | E7 — every brand mark, in its own colours: Simple Icons paths, the multi-colour Google logos, or the brand's app icon from `public/brands/`; an unknown plugin gets its initial from `PluginMark`                                                                                                                                                                                                                                                                                                                                 |
| `SectionHead`, `LedgerSection`, `LedgerRow`, `LedgerFigure`, `ReferenceBar`       | `apps/web/src/components/ledger-section.tsx`             | P2/P3 — bone head band (title left, mono ink count or a `Segmented` right, never both), 40px rows on rules, a fixed mono lane, value-vs-median                                                                                                                                                                                                                                                                                                                                                                                    |
| `Band`, `EmptyRow`, `FoldRow` (_decided_), `Day`                                  | `apps/web/src/components/ledger-section.tsx`             | `Band`: the 28px bone group head inside a pane, mono caps label, optional link right. `EmptyRow`: H1's `Name +` row on bone, the whole row the button; replaces `RailEmpty`. `FoldRow`: a 40px `25 more` row that unfolds in place. `Day`: the 88px right-aligned mono day lane a row ends on (`13 Oct`, `4 Oct 2024`, never wrapped; `when` prints today's time)                                                                                                                                                                 |
| `RecordHeader`, `RecordBody`, `RecordSection`, `PropertyGrid`, `PropertyCell`     | `apps/web/src/components/record/record-parts.tsx`        | P7 — the record anatomy: the stamp alone above the title, no readout strip, one ink line, property grid, sections                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RailSection`, `RailRow`, `RailItem`, `RailEmpty`, `StageStepper`                 | `apps/web/src/components/record/record-parts.tsx`        | the rail left of a record, printed on the ground with no box (E11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `InitialsMark`, `DitherMark`, `initialsOf`                                        | `apps/web/src/components/record/record-parts.tsx`        | ink initials squares and 1-bit fallback marks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RecordTable`, `TableToolbar`, `AddColumnButton`                                  | `apps/web/src/components/table/record-table.tsx`         | the signature grid — a boxed card with column lines and white heads, sticky head, 36px rows, Columns as an icon ending the head row, `N OF M` foot; `TableTools` is Sort and the `SearchField` with its `/`                                                                                                                                                                                                                                                                                                                       |
| `useTablePrefs`                                                                   | `apps/web/src/components/table/use-table-prefs.ts`       | per-surface column order / visibility / width, under a frozen key                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SelectionBar`, `useRowSelection`, `ListMenu`                                     | `apps/web/src/components/table/`                         | the 44px bone bar while rows are checked (count, controls, one pine verb); a list head's `···`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RecordLinkCell`, `IconBadge`, `InitialBadge`, `ChipLink`, `MetaCell`, `DateCell` | `apps/web/src/components/table/cells.tsx`                | the cell renderers a hand-declared column uses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ViewBar`, `useViewState`                                                         | `apps/web/src/components/views/`                         | saved views — **object surfaces only** (`/companies`, `/deals`, `/people`, `/o/$slug`)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SettingsSection`, `SettingsGroup`, `SettingsRow`                                 | `apps/web/src/components/settings/settings-section.tsx`  | a section of the settings shell — the shared `PageHeader` (back link and mark on a drill-in page), then `SettingsGroup` paper cards on the bone ground: a 28px paper `SettingsGroupHead`, `SettingsColumns` for a table, 48px `SettingsRow`s with an end lane, `SettingsState` for a status square                                                                                                                                                                                                                                |
| `SettingsNav`, `SETTINGS_SECTIONS`                                                | `apps/web/src/components/settings/settings-nav.tsx`      | the settings nav grammar — one row per section, groups derived, `Admin` in the lane                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `EmptyState`                                                                      | `apps/web/src/components/empty-state.tsx`                | P5 (D116) — the kind's dithered noun, serif title, the primary with its key; no subline. A filter that matched nothing is one icon-and-line row, not this                                                                                                                                                                                                                                                                                                                                                                         |
| `DitherNoun`, `DensityRamp`                                                       | `apps/web/src/components/dither-noun.tsx`, `dither.tsx`  | the only texture: an empty page's drawing per kind; loading is a density ramp, never a shimmer                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogFooter`, …                      | `apps/web/src/components/ui/dialog.tsx`                  | P8 — 48px serif head + mono context, nothing right; 16px body, or `flush` (E3); 52px bone foot, Cancel + primary; sizes below                                                                                                                                                                                                                                                                                                                                                                                                     |
| `useConfirm`, `ConfirmDialog`                                                     | `apps/web/src/components/ui/confirm-dialog.tsx`          | the destructive confirm; it replaces `window.confirm` everywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Button`, `Input`, `Label`, `Popover`, `Tooltip`, `DropdownMenu`                  | `apps/web/src/components/ui/`                            | the atoms — reticle focus, 2px radius, keys in tooltips (A2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Badge`, `badgeClasses`, `badgeTint`                                              | `apps/web/src/components/ui/badge.tsx`                   | the square option badge — takes the option row + index, `archived` and `unselected`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Select`, `selectClasses`                                                         | `apps/web/src/components/ui/select.tsx`                  | the one picker — an Input-height trigger, a paper sheet, `width` and `inset` per caller                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Checkbox`, `checkboxClasses`                                                     | `apps/web/src/components/ui/checkbox.tsx`                | the 14px square that fills with pine; a button, never a native control                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Stamp`, `spaceStamp`                                                             | `apps/web/src/components/ui/stamp.tsx`                   | the ink stamp — a plain ink rectangle, 22px, the kind only in mono caps; outlined with the day when archived                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Tabs`, `nextTabIndex`                                                            | `apps/web/src/components/ui/tabs.tsx`                    | the folder (E5, E10) — a 44px bar on the ground with a hairline foot and no fill (bone when pinned), sentence-case sans tabs 12px padded, mono counts hidden at 0, the open tab paper in ink on three sides and a pixel over the foot, `TabDivider` before the toolbar, ←→ Home End; with `children` the body is the `folder` utility. `FolderBody`: that body drawn apart from its bar. `plain`: the inner bar inside a rule card, all rule                                                                                      |
| `Segmented`                                                                       | `apps/web/src/components/ui/segmented.tsx`               | the bounded switch — 28px, a bone-deep box, the selected segment paper, counts inside; a nested switch under a tab bar, never a second tab row                                                                                                                                                                                                                                                                                                                                                                                    |
| `Switch`, `switchClasses`                                                         | `apps/web/src/components/ui/switch.tsx`                  | the 24×14 square track — graphite knob off, pine knob on, legible from one switch                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MoreMenu`, `MENU_RULE`                                                           | `apps/web/src/components/ui/more-menu.tsx`               | the one `···` — a boxed 32px trigger in a head, a bare 24px one on a row's hover; renders nothing with no enabled item; a lone frequent verb is that verb's button, a lone rare one stays in the menu (`forceMenu`, A7)                                                                                                                                                                                                                                                                                                           |
| `Twinkle`                                                                         | `apps/web/src/components/twinkle.tsx`                    | the one animated dither — a 1-bit 4×4 grid stepping in Bayer order, for a working state only, still under reduced motion                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SearchField`                                                                     | `apps/web/src/components/ui/search-field.tsx`            | D119 — the one search field, on every list's toolbar and on Email: a rule border that turns ink with focus, a graphite magnifier that turns ink, the placeholder, the `/` hint in the end slot when the page binds it (`slash`); with text the end slot is a clear cell the field's height behind a rule, ink ×, solid ink with a paper × under the pointer or keyboard focus, tooltip `Clear`; `Esc` clears, printed nowhere; the browser's own clear is hidden in `styles.css`; `fold` is the 28px icon button of a narrow pane |
| `AskMark`, `AskButton`                                                            | `apps/web/src/components/ui/ask-control.tsx`             | D119 — the mark of everything a model does: a pixel star (ink) and its companion square (pine) on a 16 grid, both paper on an ink cell; `AskButton` is the star cell, a solid ink cell joined to a bordered label, 32px or `sm` 26px, the cell alone with its label in the tooltip, `working` alternating the mark's two checker halves (still under reduced motion), `open` solid ink throughout; a menu's `Ask about this` leads with `AskMark`                                                                                 |
| `WindowControls`, `WindowClose`, `OpenAsPage`                                     | `apps/web/src/components/ui/window-controls.tsx`         | D119 — the end of a window's head: `OpenAsPage` (a bordered 32px button, the maximise glyph) when the thing has a page, a rule divider, then `WindowClose` alone, a 32px ink cell with the pixel ×, crimson under the pointer, tooltip and name `Close`                                                                                                                                                                                                                                                                           |

### Windows

A window takes one of five widths: **S 440 · M 560 · L 768 · note 900 · viewer 1152**. A confirm
or a one-field window is S, a form is M, a reading window (an email, a meeting, the
keyboard sheet) is L, a note opened over a record is 900 by the window's height less
80px (D108), and the file viewer is 1152 in every case. A window with a close in its head ends
the head on `WindowControls` (D119): `Open as a page` when its thing has a page, a
divider, then the ink close alone. The size is the
primitive's prop, never a width the caller spells. A window opened from a window steps
down under its parent, and at most one is stacked: a third is refused. Cmd-K owns its
own size (D70).

### Pickers and dates (SPA-38)

**A picker is a paper sheet, never the operating system's.** A menu or picker is
paper, 1px ink, the dithered shadow, 28px rows, the highlighted row in bone, 150/100ms
(Overlays, below), and `Select` (`apps/web/src/components/ui/select.tsx`) is that
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

**A date field stays native, and that is a decision, not an omission.** A hand-built
calendar is a month of work and an accessibility regression — the platform picker already carries locale, keyboard
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

### Controls

Every interactive element ships default, hover, focus-visible, active and disabled.

- **Buttons.** 2px radius, 26 / 32 (`sm` / default), the 24px `xs` for icon-only.
  Primary is pine under white text, hover pine-hover, press 0.97, and its key lives in
  its tooltip (`shortcut`, A2). Outline is paper in a 1px hairline that tints to bone on
  hover. Ghost is transparent until hover, for quiet in-context acts. Destructive is a
  crimson fill, never beside a primary without space. `pending` is the Motion rule's.
- **Inputs.** Transparent, 1px rule, 2px radius, 32px. The reticle draws on the input's
  own background (an input can't host `::after`), with two exceptions: a title input
  that _is_ the head of a sheet draws no marks (the caret is the focus), and a
  borderless input inside a bordered composer row draws them on the row
  (`focus-ring-within`). `Label` is sans 12 graphite, 6px above its control; an error
  sits under it in destructive 12; a placeholder is full-strength graphite. Invalid
  turns the border destructive; required-and-empty is an amber square, not a red
  border.
- **Switch.** A 24×14 square track with a 10px square knob, no radius. Off is a rule
  track on paper with a graphite knob; on is the wash with a pine border and a pine
  knob. State reads from one switch alone: a track that only moves an ink block is a
  bug. A `<button role="switch">`, not Radix's, so the reticle has no exception;
  `children` is its label, one hit area and one reticle.
- **Checkbox.** A 14px square that fills with pine and carries a 10px check; unchecked
  rests on paper in a hairline and tints to bone on hover. A `<button role="checkbox">`:
  every call site writes through a server fn when toggled, so no form needs its value.
- **Badge.** Square, 18–20px, mono 11 medium, 6px inset, the option's tint and ink.
  `Badge` takes the option row and its index, never a colour the caller resolved, so the
  board, Today and the registry land on one hue for one stage. `archived` is struck
  graphite on bone, `unselected` a dashed graphite rule. It renders a `<span>`;
  `asChild` wears a button or a link, which alone turns on hover, press and the
  reticle. The instrument's own badges (`unpriced`, `Outside mandate`) name amber as a
  stored colour and go through the same primitive.
- **Typed value editors.** One implementation for table cells, record rows and create
  windows; `variant` changes chrome only. `field` rests as a value (rule on hover,
  reticle on focus); `cell` is borderless in its row. Selects render option badges, the
  actor picker an initials square, references a 1-bit mark, ratings ink squares with a
  mono `n/max`.
- **`···`** names the more menu everywhere in this file; it draws the Carbon overflow
  glyph (`icon.more`), never three typed dots.

### Lists, ledgers and the board

- **The record table** is the hardest-working surface: spreadsheet-grade or the
  audience leaves. One 36px row height for head and body, rules between rows. The head
  is 32px, sticky, paper, sans 12 graphite labels; each head cell is a button whose menu
  carries Sort A→Z / Z→A, Clear and Hide, the direction a mono arrow after the label.
  Cells are `text-ui`, measured columns `numeric`, an empty cell a graphite em dash.
  Editors open in place, ↵ commits, Esc reverts. A stage is never cell-edited: it reads
  as a badge, and M opens Move stage so the reason is logged. The foot is 32px on a
  hairline, `N OF M` caps left.
- **A ledger row** leads with one 40px line and ends on a fixed mono lane
  (`LedgerFigure`, 64 or 80px, right-aligned). A number is never alone when a median
  exists: `ReferenceBar` draws the value in ink, the median a graphite tick, the track a
  rule. An interaction row is two lines: the subject with its badges, marks and RSVP,
  then in graphite who took part and the ✦ summary (H2).
- **The composer row.** Adding to a stream never starts from a corner button: a 40px
  row with a pine `+`, graphite hint text and the key that opens the real window
  (`+ Log a call, meeting, or note…  L`). The Tasks page grows it into the composer
  band.
- **The board.** 224px columns whose head is a mini readout (stage badge, count, Σ,
  median) on a hairline. Paper cards on rules: the 1-bit mark and name, a mono
  `company · check` with days in stage (crimson past 2× median), `close 13 Oct · Nd`
  with the owner's initials. A dashed `+ N more` folds a long column; a pine dashed
  `drop → Stage` box shows while dragging over one.

### Overlays

- **Window anatomy.** Paper, 1px ink, `shadow-solid`, 0 radius. A 48px bone head with
  the serif title 18/600 and its mono context, a hairline under it and nothing right; a
  16px paper body (E3); a 52px bone foot (A6). The first field takes the reticle on open.
  The quick task has no title bar: the input is the title. A modal must be argued for;
  inline and progressive disclosure come first.
- **Confirm.** S. The 8px crimson square and the serif question in the bone head; one
  sans sentence saying what happens and what does not, an optional rule-bordered list of
  what is affected; Keep takes focus and the destructive button carries ⌘↵.
  `useConfirm()` replaces `window.confirm`; a confirm exists to be read.
- **Menus and pickers.** Paper, 1px ink, `shadow-dither`, 28px rows, the highlighted
  row bone, 150 / 100ms, every item led by its mark (E12).
- **The attribute sheet.** 660px, two panes under the head (`New attribute` · mono
  `on Companies · 19 → 20`): a 236px type pane with the pine `›` search and 26px rows,
  the form right (name with its frozen mono slug under it, description, the per-type
  slot, default and required on one line). In edit the type pane stays, greyed: the type
  is the record of what this is. Its options editor is a rule box of 30px rows (grip,
  14px square swatch, label, mono status) ending on a composer that takes a pasted list;
  a saved option archives, struck with a mono `restore`, and only unsaved rows delete.
- **The object sheet.** Singular and plural side by side, the plural marked `guessed`
  until touched; a 1-bit icon grid of 32px tiles, the chosen one ink; the derived slug
  frozen in a bone box.
- **Command palette.** One fixed size, `min(1060px, 100vw−2rem)` ×
  `min(560px, 100dvh−4rem)`, every state in the same box, the preview pane always
  mounted (blank bone when nothing previewable is highlighted). A pine `›` prompt, caps
  group labels, 32px rows, a 32px bone foot. It **finds only**; Tab hands the query to
  Ask, and an action that needs one more answer asks it in place. With an embedding
  model, a meaning query runs 600ms after the last key and replaces the list, never
  once the selection has moved; a row found by meaning alone reads `· meaning`.
- **Ask.** A docked column (360–560px, resized from its left edge, remembered per
  browser, closed by ⌘J or ×) and `/ask` in a 760px column with a collapsible thread
  list, over one thread store. Answers are sans with ref chips and sit left at full
  measure with no box; your turn is a right-aligned bone block at most three quarters
  wide; a scope change is a centred mono divider. Scope chips sit in the composer; a
  citation previews its passage on hover; action cards propose and the person applies.
- **The keyboard sheet.** `?` opens it. Two columns of 26px rows on rules with 18px
  keycaps (hairline, 2px foot, mono 10); only keys that work are printed; chords wait
  800ms and every key is off while typing.
- **Tooltips** are inverted (ink, paper text, `text-label`), 120 / 80ms. **Toasts** are
  sonner, bottom right, ink.

### The chassis

232px of bone with a hairline right edge. The workspace head (a menu: General,
Members, Invite a member…), Search (`⌘K`), then Today, Tasks and Spaces with its starred
spaces (five, then `▸ n more`), then Library (Notes, Meetings, Email, Files, Feeds),
Objects (the objects, then customs, each object's pinned
views under it) and Capital (Portfolio, Mandate), each folding per browser
(`Library ▸ 3`). Overflow expands inline, never a dropdown. Rows are 30px with a 16px
mark lane; the current row is a hairline box on paper, every row carries the same box,
so nothing shifts. Counts only on Tasks and Email (the reader's drafts, when there are
any), ink, destructive only when a task is overdue. The foot is the Ask row (`⌘J`) above one account row, the initials square
and the name, whose menu opens to the right: `Signed in as …`, Settings (`G ,`),
Keyboard (`?`), Sign out. Collapsed it is 48px of marks with no headings, names as ink
tooltips; width snaps and is kept per browser. Below `md` it is a drawer under a 48px
top bar that prints no keys. `NAV_ITEMS` is the one list (the nav grammar, §3).

### The auth sheet

Login, setup and join share `AuthShell`: a 400px column on paper, the mark, a mono caps
eyebrow naming the step (`SIGN IN`, `SETUP · STEP 1 OF 2`), a serif title, one sans
sentence, a hairline, the form, a mono foot. Errors are a crimson square and one
sentence. No card and no centring flourish: a page head printed at the top of an empty
field.

### Empty pages and first run

An empty page shows what will live there (D116): the kind's dithered noun, the serif
title and the primary with its key; the set is on the Kit page "Empty states". A filter
that matched nothing is one icon-and-line row; an empty section is H1's row. An empty
workspace's Today is the onboarding (D80): Import a file, Drop a deck, Add a company,
gone once data exists, with no checklist. A missing setup is named where it is used
(A7); the whole picture is Settings → General → Setup, never shown unprompted.

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
whose description is a mono count line, its lanes the folder's tabs, a `max-w-220`
column of rule cards in the folder's body, 12px apart, each card
carrying its own accept/dismiss with a toast, `EmptyState` at zero. Not a table: a queue
row is a decision, not a cell.

**A settings section** — Integrations, Connections, Providers, Routing.
→ **the FX ledger**, `apps/web/src/routes/_app/settings/currency.tsx`, built from
`SettingsSection`, `SettingsGroup` and `SettingsRow`
(`apps/web/src/components/settings/settings-section.tsx`). The section is the page: the
shell draws no head of its own, so the section draws the shared `PageHeader` — the serif
title on the 24px edge, **no eyebrow and no sentence under it** (page blurbs go, D81),
the one action right, one ink line under across the full width, the action ending where the
800px column ends its content (`SETTINGS_HEAD_CAP`, E4). A page drilled into from a list
(a connection, a plugin) puts its way back above the title (`SettingsBack`,
`‹ Connections`) and its mark beside it; the head's mono line carries a member's
`Only admins can change this · ask …` and any reading the page states. The body is
`PageBody`, the bone ground: a column of paper cards 800px wide from the 12px gutter, 12px
apart (`max-w-200`), the Save bar on the 24px edge under the same cap. Each group is a
card (`SettingsGroup`): a 28px paper head with the mono caps label (`IDENTITY`,
`PROVIDERS`, `RATES`), an optional mono count beside it and an optional action right, a
rule under — never the 44px bone `SectionHead` band; rows with no group share one card
with no head. Rows (`SettingsRow`) are 48px on rules inset 11px, the label in a 210px
lane and the control in a left-aligned lane after it; the row's state (`SettingsState`,
a square then the mono word) and its action sit in the end lane at the right edge. A
row's action that goes to another page is a mono link ending `›` (`Open ›`, `Set up ›`);
one that acts in place or opens a window is a small button (`Test`, `Edit`, `Revoke…`);
a row menu of one item is that item. A ledger row leads with an icon or mark only where
it tells the rows apart. A field hint under the label survives only for cost, privacy or
something irreversible; any other explanation is a tooltip on the control
(`SettingsTip`) or goes. No settings card is hairline: a page with tabs draws the plain
bar inside a rule card. The nav left is the chassis grammar one level in: bone, each
group head a ruled band (mono caps in ink with a hairline under, the `LabelHead` grammar
the settings ledgers use), 30px rows, counts in the right lane. A table inside the
section is a card whose first row is its column heads (`SettingsColumns`), lanes shared
by head and rows. It carries no foot caption: a line under a settings ledger survives
only for cost, privacy or irreversibility (D81).

Four rules keep a settings page plain (D81 amended):

1. **A group head is a noun**, one or two words, never a clause: `Used by`, not "What it
   switches on"; `Invites`, not "Waiting to join". `settings-pages.test.tsx` fails on a
   head that opens `What` or `Who` or holds a comma.
2. **An empty card does not draw.** A card with nothing to show and nothing to act on is
   left out, as an empty section is on a record: a plugin's `Workspace key` when it asks
   for none, `Data sent`, `Used by`, `Recent runs`. A card stays when it holds the control
   that adds the first thing (Objects' `Yours`), and a page never ends blank: when its
   only card is empty, that card keeps its empty line.
3. **One group, no head.** A page that draws a single group draws it headless
   (`SettingsGroup` with `label`, no `title`): the page title already says it, the count
   is in the nav, and a head action moves to the page head (Templates, Currency & FX,
   Email forwarding, Connections, Files, Meeting notes; Members until there are invites).
   A group whose head would repeat the page title goes headless too.
4. **A column head only when it tells columns apart:** `SettingsColumns` draws on a card
   with three or more named columns, never two (Members has none). It is the list
   table's head cell — 32px, `text-label` graphite, the column rule closing each named
   lane, as `RecordTable`'s `th` draws it.

An object's attributes are a settings ledger too: column heads shared by head and rows
(Attribute · Type · Constraints · Origin · Order · Edit), a grip lane, the name with its
description under it, the raw type slug in mono, a mono constraints lane (option count,
target, currency, out of n, required, default), an origin tag (system on bone, custom on
the wash) and always-visible order and edit marks. Select rows carry their option
badges beneath. Archived attributes fold into a closed Archived section with Restore and
no grip. `A` opens New attribute.

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
(`lib/settings-moves.ts`). `admin: true` draws
the row graphite for a member with mono `Admin` in the right lane in place of a count;
it stays a link, since the page opens read-only, and changes no guard. At `md` and up settings takes over the chassis:
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
  Then one ink line, and **no readout strip**. A notices band sits under the line only
  while something needs saying (a possible duplicate, enrichment parked, the
  record archived).
- **Rail.** Left, 320px on the bone ground with no card and no border, its content on
  the 24px edge (E11). First the attribute rows (`PropertyGrid`, `PropertyCell`): a rule
  over the first and under each, a 104px label lane in sans 12 graphite led by its type's
  16px glyph (a readout's is the clock), one line truncated with the full name in its
  tooltip, then the value, 32px at least, whose editor opens in place and grows
  the row downward, never sideways. Rows print in registry order (`sort_order`; a new
  attribute takes `max + 10`) and the empty ones fold into one `n empty` row. It
  opens in place into one row per empty attribute, its label on the lane and `Set
<attribute>` in graphite where the value goes, a click opening that editor; the
  last row is `New attribute…`, and `Fewer` folds them back.
  - A value is never cut silently: sans text wraps; a mono value (domain, email,
    phone, url) that does not fit beside its label drops under it at full width, one
    value per line, with no chip at rest, and one too long even then is cut in the
    middle with the whole value in its `title` (the menu that edits it prints it whole).
  - A url prints host and path, no scheme or `www.`, with an `↗` at the row's end that
    opens it in a new tab; a click on the value still edits it.
  - A relationship with a section (Team, Associated deals, Companies, Deals, Company,
    People, and `RelationSections` for the rest) is that section only, never also a
    row; one with no section stays a row. The section is the relationship's one place,
    so it also undoes it: a row shows an unlink at its end on hover and focus, and a
    required single one (a deal's Company) swaps from the head's `+` and never
    clears. What the head says leaves the rail: a
    person's name parts (the title; `Rename…` in the `···` edits them) and a deal's
    stage (the badge, the stepper and Move stage).
  - A long text attribute (`options.longText`, the `Long text` switch on a Text
    attribute; seeded on company and person `description` and deal `close_reason`) is
    never a row: it is an Overview paragraph, and while empty it is offered in the
    fold, whose pick opens its editor in Overview.
  - A record's lone readout is a row here, not a strip in Overview: when only one
    readout has a value it prints after the last attribute row and before the
    `n empty +` row, its label on the 104px lane and its value in mono where a
    field's text starts, on the same rules (`RailRow` with `lane`). It is read only
    (no editor, no hover, no pointer), and a `bad` tone keeps its crimson.
  - Then the relations (Team, Associated deals, Spaces, Waiting), each empty one an
    `EmptyRow`. Tasks are not in the rail.
- **View.** Right, 12px from the rail, the record's folder: the 44px bar on the ground,
  the body hairline-framed and filling the height: Overview ·
  Notes · Interactions · Files · History. **Overview is first and opens every time**;
  no tab is remembered per kind. A tab that holds something carries its count; an empty
  tab is graphite with none. Overview opens on the record's long text paragraphs, in
  registry order: the label in sans 12 graphite, the text at the body step clamped to
  three lines with `More` / `Less`; a click opens a textarea in place at full width
  that commits on blur and reverts on Esc, with no Save, and a refused write holds
  crimson as a rail row does. Then the readout strip, which needs two: it draws
  only when two or more readouts have a value (never a `—` or a 0), and one alone
  is a rail row instead (`splitReadouts` decides both, once). Then the open tasks
  with their composer, the latest three threads and the latest files, each group
  a `Band` ending on a link to its tab. A list table keeps a long text to its one
  truncated line.
- **The pane.** From `xl` the page is a fixed pane (`ListPage from="xl"`, D106): the
  head never folds, the folder runs to the window's foot less the 12px gutter whatever
  the tab holds, the open tab scrolls inside it (`data-folder-scroll`) and each tab
  keeps its own place (`useFolderScroll`), and the rail scrolls in its own full-height
  column. Below `xl` the rail stacks over the body and the page scrolls as one, the
  head folding and the tab bar pinning under it.
- **A space** is the same anatomy: the head is `···` only and the stamp prints no
  depth; Overview holds its readouts (in pipeline, last filed, the funding-stage bar),
  What's moving, open tasks and the latest companies; the rail is Criteria, Watching
  and Map (D73 amended 2026-10-25).
- **The holding** has one view and no tab bar, so its figures are a card at the top of
  the column and each ledger a card under it, on the ground; no hairline.

There is no Context tab: Ask's answer card carries a `Sources n ›` footer instead. The
stacked sections of 2026-09-30, the readout strip under the title and the Notes default
of 2026-10-06 are superseded.

**A note** — the note page. → `apps/web/src/routes/_app/notes_.$noteId.tsx`, its parts
in `apps/web/src/components/notes/` (`NoteHead`, `NoteMoreMenu`, `NoteSheet`,
`NoteRail`). The record anatomy in the prose register:

- **Head.** `RecordHeader` (A4): the kind is the stamp (`NOTE`, `MEMO`), a
  private note adds an outlined `PRIVATE` beside it, and the serif title is the name
  field and wraps. One mono meta line whose shape is the note's state:
  `Anish · 13 Oct 14:02`;
  `via Granola · Priya Raman · 13 Oct · Open in Granola ↗`;
  `■ Only you · 13 Oct 14:02`;
  a replaced note's line in graphite ending `→ <newer title> ›`. Right of
  the title, the save word and the `···` and nothing else: `KIND` (three checked rows),
  a rule, Save as new version · Save as template… · Copy link, a rule, Delete…. No back
  link — the sidebar is the way back. One ink line under.
- **Body.** Under the head, the bone ground with the record body's 12px gutter, and on
  it one paper card in a 1px ink edge holding the editor alone at 72ch, left on the
  card's gutter, not centred: 17px serif, its headings 20 / 17 / 15 sans medium under
  the 28px serif title; nothing sits between the title and the editor. Nothing from
  the card up to the scroller clips: the editor's floating sheets, side menu, table
  handles and drag preview draw outside the text column. `/` offers twelve block
  types (three headings, three lists, quote, table, code block, image, file,
  divider); a block turns back into text from the toolbar's block-type select.
- **Rail.** Right of the card, `w-72` on the bone with no box and no ink, stacked
  under the card below `md`, pinned under the folded bar and the gutter (D107). A
  property grid: an 80px lane of sentence-case graphite labels, the values right, one
  rule between groups and none between a group's values. `Filed on` — records then
  spaces in the order they were filed, each led by its kind icon (Kinds), the name an
  ink link, `×` to unfile, ending on `+ File on…`, one picker for records and spaces
  (`Not filed` when there is nothing). `Mentions` and `Mentioned in` — derived, absent
  at zero. `Visible to` — `Workspace` or `Only you`, the author's switch beside the
  word. `Written` (day · who) and `Edited` (day): what the rows record. Where it landed
  from and what replaced it are the head's meta line.
- **The editor's margin.** The head stands on the 24px edge like every head, so the
  title holds its place from the Notes list. Inside the card the editor keeps
  `NOTE_INSET` (`--note-gutter`, 56px; 24px below `md`, where no hover shows the side
  menu), because BlockNote's side menu floats left of every block and needs the room:
  the prose stands at 68px, the sheet's own margin, not under the title. The
  mandate's facts and prose take the same inset inside their sheet; nothing else
  does.

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
`capital` (§2, "The chassis"; Library, Objects and Capital
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

Twenty-eight questions. A merge needs a yes to each.

**Vocabulary**

1. Is every colour a named token from the table, and every size a named step?
2. Is radius 2px on controls and 0 everywhere else — no pill, no circle, no blur?
3. Is every measured thing mono, and `numeric` where figures are comparable, with names
   and sentences in serif or sans outside the row's mono end lane?
4. Does the casing follow the three tiers? See 27.

**The seven rules** (§1, "The seven rules")

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

**Engineering** (§1, "Motion" and "Interaction engineering")

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
    cap, a grouping, or a `+ N more` fold? (§1 names virtualization past
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

**States**

28. **States** — does the surface handle every state it can reach, and does the
    issue's "Done when" name each one? Full; empty (P5, or one `Name +` row); no
    matches (with its way out); loading (the `Twinkle`, never a blank); couldn't load
    (one line and Retry); working (the `Twinkle` and present-tense words); a failed
    write (said where the write shows, with Retry, never silent and never only a
    toast); long (names wrap or truncate by rule, long lists fold); not yours or
    read-only (the control goes, the words stay); scrolled (D106 for a list or a
    record, D107 for a document); narrow (390px). A state the surface cannot reach is neither built
    nor drawn. On the canvas a state that looks the same everywhere is drawn once, on
    the Kit page; a page draws only the states that look different there.

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
  a connected calendar. The body is boxed: the readouts are one ruled card of equal
  cells (`ReadoutStrip boxed`) at the top of the main column, Needs you and Meetings are
  cards ruled all round with their bone head band inside, and the rail runs the full
  height beside them.
- **Undo holds the write.** Accepting or dismissing a suggestion, a duplicate or an Ask
  card hides the row and holds the write for 5s; the toast's `Undo` is sans and
  underlined.
- **Windows.** A confirm's dismiss says Cancel; a reply opens as Reply; the sizes and
  the stacking are §2's.
- **Cmd-K and Ask** (D70 amended): Cmd-K is one fixed size in every state with its
  preview pane always mounted, blank bone when nothing previewable is highlighted; Ask's
  scope chips sit in the composer; a citation previews its passage on hover; Ask's row
  is at the sidebar foot (`⌘J`).
- **Shell.** The foot's account row is one trigger (initials and name) whose menu is
  Settings · Keyboard · Sign out; no gear beside it; Drafts sits under Library only
  while there is one, a button that opens the drafts window; the workspace head opens
  General · Members · Invite; a password reset is a one-time link an admin issues; the phone drawer prints
  no key hints; sidebar counts are ink, destructive only when something is overdue.
- **Settings** (D81 amended): the nav group heads are ruled bands; Integrations is
  Connections · Plugins · Enrichment · Email forwarding; a settings head carries one
  outline 32px action at most beside its `···`.

**The frame** (project 27, `shell-*`; D68 amended, D70 amended)

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
- **The plugin page template**: status and version, the workspace key, what it sent,
  its manifest settings, Used by (linking to the page that owns each capability, never
  repeating its settings), recent runs and errors, an empty block not drawn, Disable and
  Uninstall… in the head's `···`. **The account page** (Options ›): the person's
  choices for that account, last sync and Disconnect. Plugins is a catalogue: Installed
  as a ledger, then Available from the registry under tabs by job (Enrichment,
  Research, Email & calendar, Files, Meeting notes, Import).
- The sensitivity floor sits at the top of AI → Models; Search reuses the Models key;
  the Models grid has no Embed row.

**Pages** (project 27 unless named)

- **Today** (D79, `today-1`): plain title with the date, the day strip, derived readouts
  only, one notices band, one Needs-you ledger with a kind lane (task, meeting, review,
  deal, mark), Today's meetings, and a rail of Portfolio and What's moving. Amended by
  the canvas port (above).
- **First run** (D80, `first-run-1`): Today's empty state with three ways in; each
  missing setup named in place with one link; Settings → General → Setup; demo
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
