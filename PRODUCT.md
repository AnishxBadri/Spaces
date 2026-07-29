# Product

## Register

product

## Platform

web

## Users

Angel investors and small private-capital teams — the design target is one investor, with
1–15 users on a shared deployment as the growth path. They self-host it: their deal terms,
decks, and cap tables never sit in someone else's SaaS. Context of use is long working
sessions — sourcing, diligence, and space research — where the app is open all day next to
email and a spreadsheet. They live in Excel and expect keyboard speed; a table worse than a
spreadsheet loses them.

## Product Purpose

An open-source, self-hosted deal-management OS for angel and private-capital investing.
Two halves on one graph: a research half (spaces, theses, notes, sources, glossary) and a
deal half (pipeline, companies, contacts, activity). The seam is the product — a company
landing in pre-lead already carries months of notes on its subspace, saved sources, and
contacts. Success looks like zero manual data entry (Gmail sync populates the graph) and the
investor's accumulated research compounding instead of rotting in scattered notes apps.

## Positioning

The only deal CRM that is also a research tool — investor-opinionated, self-hosted, and
BYOK, so the fund owns the data and the schema fits investing instead of sales.

## Brand Personality

Precise, calm, fast. Quiet confidence — the tool disappears and the work remains. Speed is
a feeling, not a spec: instant response, keyboard-first, no page reloads. One deliberate
nuance: this is a thinking tool, not just a tracking tool. Prose surfaces — notes, theses,
memos — get reading-grade typography, closer to a well-set book than a dashboard. Data
surfaces read like a ledger; prose surfaces read like a page.

## Anti-references

- **Salesforce / HubSpot CRM** — enterprise chrome, dashboards-first, configuration sprawl,
  marketing-shaped objects.
- **Generic SaaS template** — shadcn-defaults look, gradient heroes, identical card grids,
  default purple accents.
- **Dark "terminal" aesthetic** — hacker-dashboard vibe, dark-mode-only, monospace-everything,
  neon accents. (Dark mode as an option is fine; terminal cosplay is not.)

## Design Principles

1. **Density done calmly.** Lots of information without feeling crowded — Attio's tables are
   the reference. Whitespace is spent deliberately, not scattered.
2. **Keyboard is the primary input.** Cmd-K everywhere, shortcuts for every frequent action,
   mouse optional. Latency is a design defect.
3. **Two registers, one system.** Ledger register for data (tables, pipeline, attributes),
   page register for prose (notes, theses, memos). Same tokens, different type treatment.
4. **Never show an empty table.** Every surface earns its place with real or seeded content;
   onboarding lands in a populated graph, not a blank slate.
5. **Craft over decoration.** Quality comes from typography, spacing, and alignment — not
   gradients, illustrations, or chrome. If an element doesn't carry information, it goes.

## Accessibility & Inclusion

WCAG AA, pragmatic: ≥4.5:1 body-text contrast (the muted-gray temptation of the Linear lane
is explicitly bounded by this), full keyboard navigability as a core feature rather than a
compliance item, visible focus states, and `prefers-reduced-motion` support on every
animation.
