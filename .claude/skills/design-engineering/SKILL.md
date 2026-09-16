---
name: design-engineering
description: Design engineering principles for polished, accessible UI — Emil Kowalski's practices adapted to this codebase. Use when building or reviewing UI components, forms, animations, touch interactions, keyboard navigation, or performance-sensitive views. Triggers on: UI polish, input fields, form validation, button states, touch devices, mobile UX, accessibility, a11y, keyboard navigation, aria labels, layout shift, z-index, animations, transitions, easing, hover effects, tap targets, iOS Safari, prefers-reduced-motion, scrollbars, virtualization.
---

# Design Engineering (Emil Kowalski, adapted for Spaces)

Engineering-grade rules for interaction quality. **DESIGN.md is the tiebreaker** —
where this skill and DESIGN.md disagree, DESIGN.md wins.

## Spaces overrides — do NOT apply these upstream rules here

1. **Borders stay borders.** Upstream says "shadows instead of borders"
   (`box-shadow: 0 0 0 1px`). The Analyst's Desk is deliberately a crisp
   1px-border system (`--border`, hairline dividers). Keep borders.
2. **The focus ring is Pine.** Upstream says outlines only grey/black/white.
   Our `focus-ring` utility draws `--ring` (the primary) at full opacity,
   contrast-measured 4.52:1 — documented in styles.css. Keep Pine.
3. **No numbered gray scale.** Upstream prescribes `--gray-1..12` for theming.
   We use semantic OKLCH tokens (`--background`, `--muted-foreground`, …).
   Adopt the _principle_ (flip variables, never `dark:` modifiers) but express
   it through the semantic tokens when the dark theme lands.
4. **No marketing rules.** This repo has no marketing surface; the upstream
   marketing.md was deliberately not vendored.

## Already law here — don't re-litigate, just comply

- Motion: 150–250ms, ease-out (`--ease-out-quart`), state-conveying only,
  global `prefers-reduced-motion` kill switch in styles.css.
- Numbers: `.numeric` (tabular + right-aligned) in columns, `.tabular` inline.
- Buttons: `active:scale-[0.97]` ships in button.tsx; `focus-ring` everywhere.
- Typography: antialiased smoothing, named weight variables, the named type
  scale (a size not on the scale does not ship).

## Reference files

| File                                             | When                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| [animations.md](animations.md)                   | Easing, durations, springs, reduced motion, GPU rules                 |
| [ui-polish.md](ui-polish.md)                     | Layout shift, z-index, scrollbars, gradients (minus overridden rules) |
| [forms-controls.md](forms-controls.md)           | Inputs, labels, Enter/Cmd+Enter, dead zones                           |
| [touch-accessibility.md](touch-accessibility.md) | Tap targets, hover gating, keyboard nav, aria                         |
| [component-design.md](component-design.md)       | Compound components, props API, asChild                               |
| [performance.md](performance.md)                 | Virtualization, transition:all ban, preloading                        |

## Review checklist (run on any UI diff)

- [ ] No layout shift: fixed dimensions on dynamic content, no font-weight
      change on hover/selected, tabular-nums on changing numbers
- [ ] No `transition: all` — name the properties
- [ ] Animations honor reduced motion (global kill switch covers CSS; JS
      animations need `useReducedMotion`)
- [ ] Icon-only buttons have `aria-label`
- [ ] Forms submit on Enter; textareas on Cmd/Ctrl+Enter
- [ ] Hover is enhancement only (Tailwind v4 gates `hover:` on
      `(hover: hover)` by default — don't undo that)
- [ ] `touch-action: manipulation` on controls; 44px hit areas on touch
      surfaces (visual size may be smaller)
- [ ] Tab order covers only visible elements (`inert` on hidden panels);
      keyboard nav scrolls into view
- [ ] z-index from the fixed scale, never arbitrary
- [ ] Lists over ~200 rows are virtualized
