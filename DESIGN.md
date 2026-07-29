<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->

---
name: DealOS
description: Self-hosted deal-management OS for angel and private-capital investing
---

# Design System: DealOS

## 1. Overview

**Creative North Star: "The Analyst's Desk"**

A serious instrument for someone who reads for a living: a clean desk, good light, a ledger
on one side and a well-set book on the other. The interface is precise, calm, and fast —
density done the Attio way, speed felt the Linear way, and warmth carried entirely by one
gold accent and the typography, never by the surface. The tool disappears; the research
remains.

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

Restrained strategy: pure neutrals carry the entire surface; one warm gold speaks rarely
and therefore clearly.

### Primary
- **Ochre Gold** (anchor: oklch hue ~91°, seeded from oklch(0.842 0.165 91.3); working tone
  deepened toward oklch(0.60–0.68 0.13–0.15 91) — exact ramp to be resolved during
  implementation): primary actions, current selection, focus rings, active pipeline stage.
  Distinctive in the category — no CRM owns gold — and reads capital-adjacent without the
  navy-and-gold cliché. White text on any filled gold element.

### Neutral
- **Pure White** (oklch(1.0 0 0)): the body background. Literal white, no hidden warmth —
  the mood lives in the gold and the type, never in a tinted surface.
- **Panel Neutral** (to be resolved): second neutral layer for sidebar, toolbars, and rails —
  white pulled slightly toward ink, chroma ≈ 0.
- **Ink** (to be resolved): body text, ≥7:1 against white.
- **Muted Ink** (to be resolved): secondary text, ≥4.5:1 against white — the Linear-gray
  temptation is bounded by contrast, not taste.
- **Semantic set** (to be resolved): success / warning / error / info, standardized once,
  used identically everywhere. Stage and status colors are data, not decoration.

### Named Rules
**The Ten Percent Rule.** Ochre Gold touches at most 10% of any screen. Its rarity is the
signal — a gold element is either the primary action, the selection, or the focus. Nothing else.

**The Meaning Rule.** Color only ever encodes information: action, selection, state, stage,
status. If a color choice can't name what it encodes, it is forbidden.

## 3. Typography

**UI/Data Font:** [tuned sans, to be chosen at implementation — technical-humanist, strong
tabular numerals required]
**Prose Font:** [text serif, to be chosen at implementation — real italics, comfortable at
16–18px body]

**Character:** Two registers, one system. A single sans carries every interface surface —
tables, labels, buttons, attributes, navigation — in a tight scale (ratio ~1.125–1.2, fixed
rem, never fluid). A text serif appears only where the user reads: note bodies, thesis
claims, memos. Data reads like a ledger; prose reads like a page.

### Hierarchy
- **Display/Headline** (sans, semibold, modest sizes — this is product UI, nothing shouts):
  page titles, record names.
- **Title** (sans, medium): section headers, panel titles, table headers.
- **Body — UI** (sans, regular, 13–14px): the workhorse for tables, forms, attributes.
  Tabular numerals in every numeric column.
- **Body — Prose** (serif, regular, 16–18px, line-height ≥1.6, measure capped 65–75ch):
  notes, theses, memos. Reading-grade, closer to a book than a dashboard.
- **Label** (sans, medium, 11–12px): field labels, metadata, timestamps.

### Named Rules
**The Two Registers Rule.** Serif appears only in prose bodies the user reads and writes.
Never in buttons, labels, tables, navigation, or data. Sans everywhere else. No exceptions.

**The Tabular Rule.** Every number that can be compared to a number above or below it is set
in tabular figures, right-aligned. Currency, ownership %, valuations, dates in tables.

## 4. Elevation

Flat at rest. Depth is conveyed by borders and the panel-neutral layer, not shadows. Shadows
exist only as a response to state — an open dropdown, a dragged kanban card, a command
palette — and vanish at rest. One small, one medium shadow token; nothing else. Exact values
to be resolved during implementation.

**The Flat-at-Rest Rule.** A resting surface never casts a shadow. If an element is
elevated, the user did something to lift it.

## 5. Components

*Omitted — no components exist yet. This section is written by the first scan-mode run of
`/impeccable document` after scaffolding.*

Component philosophy to build toward: refined and restrained; every interactive element ships
with default, hover, focus-visible, active, disabled, loading, and error states; skeletons
over spinners; empty states that teach (and per PRODUCT.md, a table should almost never be
empty at all); motion 150–250ms, ease-out, state-conveying only, `prefers-reduced-motion`
honored everywhere.

## 6. Do's and Don'ts

### Do:
- **Do** keep the ground pure white (oklch(1.0 0 0)) and let gold + typography carry all warmth.
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
