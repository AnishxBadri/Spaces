# Instrument (v2) port brief — for the porting agent

Owner approved the Instrument design direction on 2026-09-10. Slice 1 landed as
commit `ef451b5` (tokens, mono font, reticle focus, atoms, chassis sidebar,
Companies table). This brief covers the rest. Repo is truth; the Paper canvas
is the drafting table. No runtime flag — v2 replaces v1 outright.

## Where the design lives

Paper file `spaces` (id `01M19X8AY9DZD3PZMJK7RWVMTB`). Open a page with
`open_file(fileId, pageId)`, then `get_tree_summary` to find nodes, then
`get_jsx(nodeId, "inline-styles")` for exact values. Never read values off
screenshots; use screenshots only to compare your result.

- `v2 · Foundations` (page `8-0`): Foundations sheet `40Q-0` — colour, type,
  material, seven named rules. Texture sheet `211-0`.
- `v2 · Components` (page `9-0`): Atoms `2GW-0`, Overlays `2GX-0`,
  Chassis + Ledger `4GV-0`, Ledger · Editing `4RI-0`, Overlays · Flows `56M-0`,
  Rails · Settings · Ledgers `5LB-0`.
- `v2 · Patterns` (page `A-0`): Patterns `45Y-0` (P1 page header + readouts,
  P2 ledger section, P3 attention row, P4 board column, P5 empty state,
  P6 composer band, P7 record anatomy, P8 overlay anatomy).
- `v2 · Surfaces` (page `B-0`): Today `385-0`, Companies `1N8-0`, Deal `210-0`,
  Deals — Board `3H2-0`, Tasks `3H3-0`.

## The rules (all seven are on the Foundations sheet)

1. Meaning Rule — colour only encodes action / selection / state / stage / status.
2. Two-Tier Rule — pine is the only saturated fill; badges are tint + same-hue ink, square.
3. Numeral Rule — everything measured is mono (`mono`, `numeric`, `tabular`):
   money, counts, dates, durations, IDs, domains, column labels. Names and prose never.
4. Reticle Rule — focus is `focus-ring` / `focus-ring-inset` (already implemented).
   Never add a pine ring or outline.
5. Dither Rule — 1-bit, pine or ink, never under text, never animated. Only in
   empty states, chart fills, fallback marks, thumbnails, loading. Pre-render as
   SVG with explicit rects (`<pattern>` is fine in the browser, but keep cells 2px).
6. Contrast Floor — body ≥ 4.5:1, graphite is the only secondary text colour.
7. No-Bar Rule — pine never appears as a left/edge inset bar. Current page =
   paper + rule + medium weight. Selected row = wash + check. Highlighted option
   = bone. Winner = ink vs graphite.

## Vocabulary already in `src/styles.css`

Tokens: `--paper --bone --bone-deep --hairline --rule --graphite` and Tailwind
colours `bg-paper bg-bone bg-bone-deep border-hairline border-rule text-graphite`.
Utilities: `mono`, `label-caps` (mono 11 caps .08em), `title-serif` (Source
Serif 28/32 600), `numeric`, `tabular`, `focus-ring`, `focus-ring-inset`.
Radius: `rounded-md` = 2px; `rounded-none` for chassis, cards, badges, dialogs.
Shadows: popover `shadow-[2px_2px_0_0_var(--hairline)]`, dialog
`shadow-[3px_3px_0_0_var(--hairline)]`. Never blur.
Heights: row 36 (`h-row`), control 32 (`h-8`), small 26, badge 20, nav row 30,
header row 48, readout strip 56–64, dialog head 44, dialog foot 52.

## Slices, in order (one commit each, gates green before each commit)

1. **Page header + readout strip** (Patterns P1; Today `385-0` header `3BN-0`
   and readouts `3BY-0`). Extract a `PageHeader` that takes a serif title (or
   sentence), mono readout line, actions right with key hint inside the button
   (`<kbd class="mono text-micro opacity-85">`). Add a `ReadoutStrip` (cells
   split by `border-r border-rule`, label `label-caps text-graphite`, value
   mono 20/500, colour only when nonzero and bad: `text-destructive`,
   `text-warning`). Apply to `/today` (six cells: overdue, due today, idle
   deals, stale marks, missing FX, dedupe). Today's route is
   `src/routes/_app/today.tsx`; keep its data hooks, replace its markup.
2. **Ledger section + attention rows** (Patterns P2/P3; Today spine `3CI-0`).
   A `LedgerSection` (caps label + mono count left, link right, hairline under,
   36px rows on rules, last row may be a composer). Today's Due / Idle / Stale
   use it; Idle rows get the days-vs-median bar (`3DX-0`). Bone rail on the
   right with the portfolio strip and 24h ledger (`3CJ-0`).
3. **Deal record** (`210-0`): breadcrumb mono caps, actions with key hints,
   serif name + square badge, five-cell readout strip, 3-column property grid
   (hairline top/bottom, rules inside, `label-caps` 10px labels), serif thesis
   17/27 max 640, ledger timeline (mono time + type columns), bone rail
   (stage stepper of 6 segments, readouts with sparklines, people with ink
   initials). Route `src/routes/_app/deals_.$dealId.tsx`. Companies/people
   record pages share the anatomy — port them after deals with the same parts.
4. **Board** (`3H2-0`): 224px columns, header = badge + count + Σ + median,
   paper cards with rule border, days-in-stage crimson past 2× median, close +
   owner initials row, dashed "+N more", pine dashed drop target.
   `src/components/deal-board.tsx`.
5. **Tasks** (`3H3-0`): bone composer band under the header (P6) with parsed
   date chip in ink, quick chips, assignee/link chips, create-more switch;
   urgency ledgers Overdue/Today/This week/Later/No date.
   `src/routes/_app/tasks.tsx`, `src/components/task-composer.tsx`.
6. **Overlays** (`2GX-0`, `56M-0`, Patterns P8): give `DialogContent` the
   anatomy — 44px head (serif title 18/600 + mono context, `esc` right, hairline
   under), 20px body, 52px bone foot (mono note left, buttons right, primary
   carries ⌘↵). Then re-skin: create deal, move stage (numbered rows, reason
   field), log interaction (segmented type 1–5, chips, serif notes), quick task
   (T, no title bar), new attribute, new object, dedupe pair card, destructive
   confirm, command palette (`3TC`-style: › prompt, group labels caps, foot).
7. **Editing** (`4RI-0`): attribute cells rest/edit per type; status is never
   cell-edited (M opens Move stage); combobox/date/money/chip pickers as paper
   sheets with hard shadow; column header menu, columns popover, row hover
   actions, ink bulk bar, load-more foot. `src/components/attributes/*`,
   `src/components/table/*`.
8. **Rails, settings, import, portfolio ledger** (`5LB-0`): tasks/files/spaces
   rails, dropzone rest + drag states, settings section pattern with the FX
   table, import mapping rows, portfolio ledger with struck superseded rows and
   no edit affordances. Collapsed 48px chassis is optional.
9. **Empty states + texture** (`211-0`, P5): dither block + serif sentence +
   one sans line + primary with key. `src/components/empty-state.tsx`. Fallback
   company marks as 1-bit tiles; loading as density ramps, no shimmer.
10. **DESIGN.md rewrite**: north star "a measuring instrument for capital,
    printed output"; replace §2–§4 with the Foundations sheet; keep the
    decision history; add the seven rules. Update `docs/ARCHITECTURE.md`
    design pointers if they reference the old focus ring.

## Gates before every commit (CLAUDE.md)

`pnpm exec tsc --noEmit` · `pnpm exec vitest run` (Postgres via
`docker compose -f docker-compose.dev.yml up -d`) · prettier on touched files ·
`pnpm lint` zero errors. One-line commit subject. Verify in the browser with
Chrome MCP against the real dev DB (`pnpm dev`, login `anish@fund.example`).
Radix dialogs don't open from synthetic clicks — use `javascript_tool` with
`element.click()`. The machine has run low on memory once this session: run
vitest at commit points only, and don't leave two dev servers up.

## Traps

- `src/lib/server-fns.ts` is a client barrel; no server helpers there.
- Never `Intl.NumberFormat` compact — use `fmtMoney`.
- Money is `numeric` → strings; parse at the boundary.
- Portfolio event tables are append-only; draw no edit/delete affordance.
- Tailwind bare `rounded` is still 4px (the `--radius` var lives in `:root`);
  use `rounded-md` (2px) or `rounded-none` explicitly.
- `NAV_ITEMS` order feeds the command palette.
