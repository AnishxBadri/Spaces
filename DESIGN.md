---
name: DealOS
description: Self-hosted deal-management OS for angel and private-capital investing
colors:
  pine: 'oklch(0.55 0.14 155)'
  pine-hover: 'oklch(0.5 0.14 155)'
  selected-wash: 'oklch(0.962 0.022 155)'
  ground: 'oklch(1 0 0)'
  ink: 'oklch(0.24 0.012 155)'
  muted-ink: 'oklch(0.49 0.016 155)'
  panel: 'oklch(0.976 0.003 155)'
  border: 'oklch(0.92 0.005 155)'
  input-border: 'oklch(0.885 0.006 155)'
  row-hover: 'oklch(0.977 0.003 155)'
  destructive-crimson: 'oklch(0.48 0.17 12)'
  success-teal: 'oklch(0.55 0.09 190)'
  warning-amber: 'oklch(0.7 0.13 75)'
  info-blue: 'oklch(0.55 0.1 240)'
typography:
  display:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.625rem'
    fontWeight: 600
    lineHeight: '2rem'
    letterSpacing: '-0.025em'
  headline:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.375rem'
    fontWeight: 600
    lineHeight: '1.75rem'
    letterSpacing: '-0.025em'
  title:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.9375rem'
    fontWeight: 600
    lineHeight: '1.375rem'
  body:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: '1.25rem'
  ui:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.8125rem'
    fontWeight: 400
    lineHeight: '1.25rem'
  label:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.75rem'
    fontWeight: 500
    lineHeight: '1rem'
  micro:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.6875rem'
    fontWeight: 500
    lineHeight: '1rem'
  prose:
    fontFamily: 'Source Serif 4 Variable, Georgia, serif'
    fontSize: '1.0625rem'
    fontWeight: 400
    lineHeight: 1.65
rounded:
  sm: '4px'
  md: '6px'
  lg: '8px'
  xl: '12px'
spacing:
  row: '2.25rem'
components:
  button-primary:
    backgroundColor: '{colors.pine}'
    textColor: '#ffffff'
    rounded: '{rounded.md}'
    padding: '8px 16px'
    height: '36px'
  button-primary-hover:
    backgroundColor: '{colors.pine-hover}'
  button-outline:
    backgroundColor: '{colors.ground}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: '6px 12px'
    height: '32px'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    height: '32px'
  input:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: '4px 12px'
    height: '36px'
---

# Design System: DealOS

## 1. Overview

**Creative North Star: "The Analyst's Desk"**

A serious instrument for someone who reads for a living: a clean desk, good light, a ledger
on one side and a well-set book on the other. The interface is precise, calm, and fast —
density done the Attio way, speed felt the Linear way, and character carried entirely by
one deep pine-green accent and the typography, never by the surface. The tool
disappears; the research remains.

This system explicitly rejects enterprise CRM chrome (Salesforce/HubSpot dashboards-first
sprawl), the generic SaaS template look (shadcn defaults, gradient heroes, purple accents,
identical card grids), and the dark terminal aesthetic (monospace-everything, neon on black).
Familiarity is earned through craft — typography, spacing, alignment — not through decoration.

**Key Characteristics:**

- Pure white ground; color appears only where it carries meaning
- Two registers, one system: ledger for data, page for prose
- Keyboard-first; latency is a design defect
- Dense tables that stay calm — whitespace spent deliberately, not scattered
- WCAG AA is a floor, not a target: body text ≥4.5:1, always

## 2. Colors

Restrained strategy: pure neutrals carry the entire surface; one deep pine green speaks
rarely and therefore clearly. Every value below is live in `src/styles.css` — this section
describes; the CSS decides.

### Primary

- **Pine** (oklch(0.55 0.14 155) ≈ #00884b): primary actions, current selection, focus
  rings. Third primary, by owner decision (2026-08): Ochre Gold fell to contrast physics
  (2026-07), Vermilion to preference for a quieter, capital-coded voice. Costs accepted
  knowingly: green is fintech's most-owned hue, and the success semantic had to move off
  green so an action and a state never share a hue. What green gives back: at
  contrast-passing lightness it holds less chroma than vermilion, so the one loud voice
  in the system is naturally more restrained — a sturdier, instrument-like read.
  Lightness is pinned by contrast: 0.55 measures 4.52:1 with white text (measured via
  proper OKLCH→sRGB conversion, never eyeballed). Hover deepens to oklch(0.5 0.14 155),
  5.51:1; the selection wash is a pale same-hue tint, oklch(0.962 0.022 155), 14.8:1
  under ink.

### Neutral

- **Pure White** (oklch(1 0 0)): the body background. Literal white, no hidden tint —
  the mood lives in the pine and the type, never in a tinted surface.
- **Ink** (oklch(0.24 0.012 155)): body text, ~13:1 against white.
- **Muted Ink** (oklch(0.49 0.016 155)): secondary text, ≥4.5:1 — the Linear-gray
  temptation is bounded by contrast, not taste. No sub-100% opacity variants of it, ever;
  that is how the floor gets quietly broken.
- **Panel Neutral** (oklch(0.976 0.003 155)): second neutral layer for sidebar, toolbars,
  and rails. Borders at oklch(0.92 0.005 155), inputs slightly darker.
- All neutrals carry a whisper of the primary hue (~155°) at near-zero chroma, so grays
  feel of-the-brand without reading tinted.

### Semantic

- **Destructive** is deep crimson (oklch(0.48 0.17 12)) — chosen under the vermilion
  primary to keep delete unmistakable from act, kept under pine because it still reads
  unambiguously destructive against everything else.
- **Success moved to teal** (oklch(0.55 0.09 190), 2026-08): pine owns green now, and a
  success _state_ sharing the action hue would blur two meanings — the Meaning Rule
  applied to the system itself. Warning oklch(0.7 0.13 75) · info oklch(0.55 0.1 240).
  Standardized once, used identically everywhere. Stage and status colors are data, not
  decoration.

### Badge palette

Twelve hues (slate → cyan around the wheel) for select/status options, every one built
the same way: a pale tint at L 0.955 and same-hue ink at L 0.45, chroma fitted to the
largest the sRGB gamut allows at that lightness. Fixing lightness across all twelve is
what makes them read as one system rather than a bag of colours, and it means no hue can
quietly fall below the contrast floor — the worst pair measures 6.26:1, the best 7.02:1.
Options get a hue auto-assigned; users can override per option in settings.

### Named Rules

**The Two-Tier Rule** (2026-07 — supersedes the Ten Percent Rule). Badges may take any of
twelve hues, so rarity can no longer be what marks the primary out. Instead: **the primary
is the only fully saturated fill on a surface; option badges are always a pale tint with
same-hue ink.** Action and data therefore never compete, however many badge colours are
in play.

**The Meaning Rule.** Color only ever encodes information: action, selection, state, stage,
status. If a color choice can't name what it encodes, it is forbidden.

**The Focus Rule.** One treatment everywhere: the `focus-ring` utility — a 2px outline at
full `--ring` (the primary, 4.52:1 on white), 1px offset, drawn only on `:focus-visible`;
`focus-ring-inset` for cells and rows inside scroll containers, where an offset ring would
be clipped. Translucent rings are banned — both of the old competing treatments sat under
the 3:1 non-text floor (WCAG 2.2 SC 1.4.11). Outline, not box-shadow: costs no layout,
needs no offset colour plumbed through.

## 3. Typography

**UI/Data Font:** **Inter Variable** (`cv11` + `ss01` enabled; tabular numerals on demand).
**Prose Font:** **Source Serif 4 Variable.**
Both self-hosted via Fontsource — no font CDN calls from a privacy product.

**Character:** Two registers, one system. A single sans carries every interface surface —
tables, labels, buttons, attributes, navigation — in a tight scale (fixed rem, never
fluid). A text serif appears only where the user reads: note bodies, memos, the mandate.
Data reads like a ledger; prose reads like a page.

### The named scale

Seven steps, each mapping to one role. **If a size isn't on this list it does not go in
the app** — no `text-[15px]` arbitraries.

| step           | size | role                                           |
| -------------- | ---- | ---------------------------------------------- |
| `text-micro`   | 11px | timestamps, chip counts, avatar initials       |
| `text-label`   | 12px | field labels, metadata                         |
| `text-ui`      | 13px | the table + form workhorse                     |
| `text-body`    | 14px | default running text in UI (the body baseline) |
| `text-title`   | 15px | section headers, panel titles                  |
| `text-page`    | 22px | page titles                                    |
| `text-display` | 26px | record names                                   |

The prose register opts out of the scale: note bodies render serif at 17px, line-height
1.65 (`.prose-note`), headings inside prose stay sans.

### Named Rules

**The Two Registers Rule.** Serif appears only in prose bodies the user reads and writes.
Never in buttons, labels, tables, navigation, or data. Sans everywhere else. No exceptions.

**The Tabular Rule.** Every number that can be compared to a number above or below it is set
in tabular figures, right-aligned. Currency, ownership %, valuations, dates in tables.
Made structural, not remembered: the `.numeric` utility is tabular + right-aligned in one
class, so the two halves cannot drift apart; `.tabular` alone is for figures inline in a
sentence or chip ("12 of 40"), where right-alignment would be wrong.

### Rhythm

- **Row height:** one token, `--row-h: 2.25rem`, shared by table headers and body rows so
  a sticky header sits flush against the first row. Exposed as `spacing-row`.
- **Radius:** `--radius: 0.375rem` — crisper than shadcn's 10px default; this is a tool,
  not a toy.
- Row hover is an _opaque_ neutral (`--row-hover`), never a translucent tint: a
  translucent hover on a sticky column lets the columns scrolling underneath bleed
  through it.

## 4. Elevation

Flat at rest. Depth is conveyed by borders and the panel-neutral layer, not shadows. Shadows
exist only as a response to state — an open dropdown, a dragged kanban card, a command
palette — and vanish at rest. In practice the code uses Tailwind's stock shadows and only
on lifted surfaces (`shadow-xs` on triggers, `shadow-md`/`shadow-lg` on popovers and
dialogs); no custom shadow tokens have been needed, and none should be minted until a
surface demands one.

**The Flat-at-Rest Rule.** A resting surface never casts a shadow. If an element is
elevated, the user did something to lift it.

## 5. Components

Refined and restrained: every interactive element ships with default, hover,
focus-visible, active, and disabled states; empty states teach; skeletons over spinners.
Documented from the shipped code (2026-08, post-sweep) — one focus treatment, named type
steps, and the motion doctrine below apply to every component without exception.

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

**The Compositor Rule.** If a motion can't be expressed in transform + opacity, it
doesn't ship.

### Buttons

- **Shape:** crisp corners (6px radius), heights 24 / 32 / 36 / 40px (`xs / sm / default / lg`).
- **Primary:** the only saturated fill on any surface — Pine on white text
  (oklch(0.55 0.14 155), 4.52:1), hover deepens to pine-hover, press compresses to 0.97.
- **Outline:** white ground, 1px border, `shadow-xs`, hover tints to the accent neutral.
- **Ghost:** transparent until hover; used for in-context quiet actions.
- **Destructive:** crimson fill, white text — never adjacent to a primary without space.
- **Focus:** the app-wide `focus-ring` outline; the shadcn translucent ring was
  deliberately replaced and must not return with re-vendored primitives.

### Inputs / Fields

- **Style:** transparent background, 1px `input-border` stroke, 6px radius, 36px height,
  `shadow-xs`; selection highlight uses the primary.
- **Focus:** `focus-ring` outline plus the border shifting to the ring color.
- **Placeholders:** full-strength Muted Ink — never a sub-100% opacity.
- **Invalid:** border and ring shift to destructive.
- **Date fields:** native control in forms; in table cells a date renders as formatted
  text until clicked (the native `mm/dd/yyyy` skeleton breaks the em-dash empty-cell
  convention).

### The Record Table (signature)

The hardest-working surface; spreadsheet-grade or the audience leaves.

- **Rows:** one `--row-h` (36px) shared by header and body — the sticky header sits
  flush; borders at 60% border color between rows, none after the last.
- **Header:** sticky, white, `text-ui` medium; resizable and hideable columns.
- **Hover:** the _opaque_ `row-hover` neutral (translucency bleeds under sticky columns).
- **Cells:** `text-ui` (13px); editors are borderless until hover ('cell' variant);
  comparable numbers set `.numeric`; empty cells render an em dash.
- **Focus inside the scroll container:** `focus-ring-inset`, never the offset ring.

### Typed Value Editors (signature)

One implementation shared by table cells, record rails, and create dialogs — `variant`
only changes chrome ('cell' is borderless-until-hover; 'field' looks like a form input).
Selects/statuses/multi-selects render option badges; ratings render primary-filled stars;
checkboxes are 16px squares that fill with the primary when checked. Create-dialog layout
is type-driven: half-width fields in a two-column grid, long-form (`description`)
spanning both — the registry generates the form, so the span rule survives any custom
attribute.

### Option Badges

Pills carrying select/status/stage values: pale tint background + same-hue ink from the
twelve-hue palette, `text-label` (12px) medium, full radius. Data colors, never
decoration; the Two-Tier Rule guarantees they never compete with the primary.

### Navigation

Fixed 240px sidebar on the panel neutral; items are 32px rows, `text-ui` medium, Muted
Ink at rest → ink on hover with the accent tint → the selection wash + ink when active
(`aria-current="page"`). The workspace name (or wordmark) heads it; Cmd-K search sits
directly beneath. Collapses to a drawer under a 48px top bar on mobile.

### Overlays (Dialogs · Menus · Tooltips)

- **Dialogs:** centered, max-height 85vh with internal scroll, 8px radius, `shadow-lg`,
  1px border; enter 180ms fade+zoom-in-95, exit 120ms. Wide (672px) when a form has >4
  fields, narrow (384–448px) otherwise. A modal must be argued for — previews and
  create-forms qualify; navigation does not.
- **Menus/dropdowns:** popover white, 1px border, `shadow-md`, origin-aware 150/100ms,
  items 32px with the accent hover tint.
- **Tooltips:** inverted (ink background, background text), `text-label`, 120/80ms.
- **Toasts:** sonner, bottom-right, self-contained motion.

### Empty States (teaching)

Centered, max 24rem: an icon in a 44px muted rounded square, `text-title` semibold
headline, two sentences of Muted Ink body that explain what the surface will do, then the
create action — and, where relevant, a quiet hint line about what automation will fill
this later. A table should almost never be empty at all (demo seed exists for that).

## 6. Do's and Don'ts

### Do:

- **Do** keep the ground pure white (oklch(1 0 0)) and let pine + typography carry all character.
- **Do** hold body text at ≥4.5:1 contrast — muted gray "for elegance" is the first failure mode of this aesthetic lane.
- **Do** set every comparable number in tabular figures, right-aligned.
- **Do** give every interactive element a visible focus state — keyboard is the primary input.
- **Do** use density confidently in tables; calm comes from alignment and rhythm, not sparseness.

### Don't:

- **Don't** ship anything that reads as "Salesforce/HubSpot CRM" — enterprise chrome, dashboards-first, configuration sprawl.
- **Don't** ship the "generic SaaS template" look — shadcn-default styling, gradient heroes, identical card grids, default purple accents.
- **Don't** drift into the "dark terminal aesthetic" — dark-only, monospace-everything, neon accents. (A proper dark theme is a feature; terminal cosplay is a ban.)
- **Don't** use serif type in any UI control, label, table, or navigation — prose bodies only.
- **Don't** use color decoratively. No gradient text, no side-stripe borders (`border-left` > 1px as accent), no glassmorphism.
- **Don't** animate for decoration. Motion conveys state; no entrance choreography, nothing over 250ms.
- **Don't** reach for a modal first. Inline and progressive disclosure are the defaults; modals are the exception that must be argued for.
