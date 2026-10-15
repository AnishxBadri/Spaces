# Canvas brief — wave 2 (shared by every page agent)

Paper file `01M19X8AY9DZD3PZMJK7RWVMTB`. Each agent owns one page and passes
its `pageId` to every page-scoped call; never write to another page.

## Load and read first

1. ToolSearch, one call: `select:mcp__paper__get_guide,mcp__paper__get_basic_info,mcp__paper__get_font_family_info,mcp__paper__create_artboard,mcp__paper__write_html,mcp__paper__duplicate_nodes,mcp__paper__update_styles,mcp__paper__set_text_content,mcp__paper__move_nodes,mcp__paper__delete_nodes,mcp__paper__rename_nodes,mcp__paper__get_screenshot,mcp__paper__get_tree_summary,mcp__paper__get_children,mcp__paper__get_jsx,mcp__paper__find_nodes,mcp__paper__get_node_info,mcp__paper__finish_working_on_nodes`.
2. `get_guide({topic:"paper-mcp-instructions"})`; `get_font_family_info` for
   Inter, Source Serif 4, JetBrains Mono.
3. `docs/product-map.md` — whole file. "The canvas" and "The rules in force"
   are binding.
4. Screenshot (scale 0.5–1) the library and the wave-1 pages you build on:
   - Kit 9-0: Actions WTD-0, Inputs WZ6-0, Navigation X59-0, Data X8V-0,
     Overlays UBA-0, Display U4G-0, Chassis UDH-0, Ledger UJL-0, Record parts
     UN1-0, Marks and chips UPX-0.
   - Foundations 8-0: Hierarchy V7H-0, Motion 6TJ-0, State changes TLH-0
     (the twinkle loader).
   - Grammar A-0: Action grammar UX6-0 (A1–A10, H1–H3).
   - Record p-S-0 (adopted): 01 Anatomy XCO-0 (screen XD2-0), 03 Overview
     XCQ-0, 05 Interactions XCS-0, 11 States XCY-0, 12 Interactions XCZ-0.
   - Lists p-R-0: 01 Anatomy XMF-0, 04 Selection 1099-0, 07 States 1235-0.
     Use `get_tree_summary` to find the node ids you clone.

## How a page is drawn

- One board per shape instance, 1440 wide, `height: fit-content`, one row at
  x = 0, 1520, 3040 …, name `NN Title`. Inside: an 11px mono caps graphite
  label (`01 · ANATOMY`), the UI, then the **states strip** and the
  **interaction instances** side by side. Cases are drawn, not written.
- Clone, never redraw: `<x-paper-clone node-id="…" />` inside write_html, or
  `duplicate_nodes` then `update_styles` / `set_text_content`. A button,
  input, tab bar, row, stamp, window chrome or menu that Kit has is cloned.
- Write small: one visual group per write_html. Screenshot after each board,
  critique against the guide's Review Checkpoints and the rules, fix, move on.
- Tokens only (`var(--color-paper)` …), px font sizes, no raw hex.
- Canvas text = the board label, the UI, and one caption per board naming the
  code symbol and file (`EmailDialog · email-dialog.tsx`), with `proposed`
  wherever the drawing is ahead of or contradicts the code. No explanatory
  sentences. A hint inside the UI survives only for cost, privacy or
  something irreversible; anything else is a tooltip.
- Mock data from the schema (`packages/core/src/attributes/registry.ts`, the
  enums) and the record set already on the Record page: Exponent, Priya Raman
  (CEO), Dev Shah (CTO), Kavya Iyer, Meera Nair, Arjun Mehta, Lattice
  Capital, Northgate Ventures, spaces Proptech › Property ops, India seed.
- Call `finish_working_on_nodes` when done. Never touch tokens, other pages,
  code or git.

## Lessons from wave 1 (each one cost a fix round)

- **Dates:** today `10:42` (or `Today` in a readout), this year `13 Oct`,
  older `4 Oct 2024`. Never `MM-DD` or ISO outside an input. Ages under 30
  days may stay as ages (`3d`). Today is **Thu 15 Oct 2026**; check every
  weekday you print against the real calendar (Fri 16, Mon 19, Tue 20 Oct).
- **Casing:** nothing starts lowercase — column heads, labels, state words
  (`In sync`), buttons. CAPS mono only for kinds and band/group labels.
- **Tabs:** an open tab is straight-edged on both sides; never slanted,
  never chamfered. One tab bar per screen; a nested switch is the Kit
  Segmented (selected = paper inside a bone band, counts inside). No count at 0.
- **Stamps** are plain rectangles (clone from Record 02 Heads), never
  chamfered.
- **Loading** is the twinkle (State changes TLH-0), never grey skeleton bars.
- **Colour:** green (primary) only on the one affirmative button and where
  Kit uses it. Not for links, run-now words or `+` marks — those are ink or
  graphite. Destructive red only on a destructive action.
- **Overlap:** check every row at scale 1 for text colliding with a badge or
  the next lane; give badges their own fixed-width lane.
- **Printed source pages** (p-F … p-O) are pre-grammar. Clone pieces from
  them, then apply every rule above on the way in.

## Report back (short)

- Board name → node id, one line each.
- Decisions not in the rules, or contradicting code/contract, one line each,
  saying which.
- Questions for the owner, max 5. No HTML, no long descriptions.
