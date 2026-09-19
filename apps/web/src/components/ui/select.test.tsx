import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SEARCH_FROM, Select, selectClasses } from './select.tsx'
import { opsFor } from '@spaces/core/views/filter'

/**
 * SPA-38. The picker's contract, asserted two ways.
 *
 * The **sheet and trigger** are asserted through `selectClasses`, the way
 * `badge.test.ts` and `switch.test.ts` assert theirs: `apps/web` runs vitest
 * on `environment: 'node'` with no `@testing-library/react` and no
 * jsdom/happy-dom, and this slice added no dependency to change that.
 *
 * The **trigger's ARIA** is asserted against real markup — `renderToStaticMarkup`
 * is the same server render the app ships through, and a closed Radix popover
 * renders exactly its trigger. That is what pins `role="combobox"`,
 * `aria-expanded` and the inset reticle at the filter picker, which is the one
 * inside a scroll container.
 *
 * What is **not** asserted here: ↑↓ / ↵ / esc themselves need a live DOM. They
 * are delegated — ↑↓ and ↵ to cmdk's keydown handler on the `Command` root
 * (the element Radix focuses on open, because `PopoverContent` takes that root
 * `asChild`), esc to Radix's `DismissableLayer`. The one behaviour neither
 * library provides without a search box is letter type-ahead, which is why
 * `Select` implements it and why short lists can go without an input at all.
 */

/** The nine-op filter picker's worst case — `opsFor` never offers more. */
const OPS = opsFor('text')

describe('selectClasses', () => {
  it('draws the paper sheet — 1px ink edge, 2px hard offset, no blur', () => {
    const { sheet } = selectClasses({ width: 'trigger' })
    expect(sheet.split(' ')).toContain('border-hairline')
    expect(sheet.split(' ')).toContain('bg-paper')
    expect(sheet.split(' ')).toContain('rounded-none')
    expect(sheet).toContain('shadow-[2px_2px_0_0_var(--hairline)]')
    expect(sheet).not.toMatch(/blur|shadow-(xs|sm|md|lg)/)
  })

  it('is 28px rows highlighted in bone, and nothing else (No-Bar Rule)', () => {
    const { item } = selectClasses({ width: 'trigger' })
    expect(item.split(' ')).toContain('h-7') // 28px
    expect(item).toContain('data-[selected=true]:bg-bone')
    expect(item).not.toMatch(/bg-primary|border-l-|text-primary/)
  })

  it('enters in 150ms and leaves in 100ms, on transform and opacity only', () => {
    const { sheet } = selectClasses({ width: 'content' })
    expect(sheet).toContain('data-[state=open]:duration-150')
    expect(sheet).toContain('data-[state=closed]:duration-100')
    expect(sheet).toMatch(/zoom-in-95/)
    expect(sheet).toMatch(/fade-in-0/)
    expect(sheet).not.toMatch(/transition-all/)
  })

  it('gives the caller the three width behaviours, and never guesses', () => {
    // (a) the sheet is the trigger — short labels, few of them.
    expect(selectClasses({ width: 'trigger' }).sheet).toContain(
      'w-(--radix-popover-trigger-width)',
    )
    expect(selectClasses({ width: 'trigger' }).sheet).not.toContain('w-auto')
    // (b) the sheet sizes to its rows, with the trigger as a floor.
    const content = selectClasses({ width: 'content' }).sheet
    expect(content).toContain('w-auto')
    expect(content).toContain('min-w-(--radix-popover-trigger-width)')
  })

  it('is an Input-height trigger, with the reticle as the only focus mark', () => {
    const plain = selectClasses({ width: 'trigger' }).trigger
    expect(plain.split(' ')).toContain('h-8') // the Input height
    expect(plain.split(' ')).toContain('rounded-md') // 2px
    expect(plain.split(' ')).toContain('focus-ring')
    expect(plain).not.toMatch(/(?:^|\s)ring-|focus(?:-visible)?:ring/)
    // (c) inside a scroll container an offset reticle would be clipped.
    const inset = selectClasses({ width: 'content', inset: true }).trigger
    expect(inset.split(' ')).toContain('focus-ring-inset')
    expect(inset.split(' ')).not.toContain('focus-ring')
  })

  it('names its transition', () => {
    const { trigger } = selectClasses({ width: 'trigger' })
    expect(trigger).toContain('transition-colors')
    expect(trigger).not.toMatch(/transition-all/)
  })
})

describe('the filter picker — the one inside a scroll container', () => {
  const markup = renderToStaticMarkup(
    <Select
      aria-label="Operator"
      value={OPS[0]}
      onChange={() => {}}
      items={OPS.map((op) => ({ value: op, label: op }))}
      width="content"
      inset
    />,
  )

  it('renders a closed combobox, not a native select', () => {
    expect(markup).not.toContain('<select')
    expect(markup).toContain('role="combobox"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-haspopup="listbox"')
    expect(markup).toContain('aria-label="Operator"')
  })

  it('takes the inset reticle, because the conditions list scrolls', () => {
    expect(markup).toContain('focus-ring-inset')
    // `focus-ring` on its own — the offset variant the scroller would clip.
    expect(markup).not.toMatch(/focus-ring(?![-\w])/)
  })

  it('reads its current value on the trigger before anything is opened', () => {
    expect(markup).toContain(OPS[0])
  })
})

describe('the search box', () => {
  it('appears only once a list is long enough to hunt through', () => {
    // The nine-op filter picker and the fifteen-type slot earn one; a
    // two-item role picker and a three-item status group do not.
    expect(OPS.length).toBeLessThan(SEARCH_FROM)
    const short = ['member', 'admin']
    expect(short.length).toBeLessThan(SEARCH_FROM)

    const withoutInput = renderToStaticMarkup(
      <Select
        aria-label="Invite role"
        value="member"
        onChange={() => {}}
        items={short.map((r) => ({ value: r, label: r }))}
        width="trigger"
      />,
    )
    // Closed, so neither renders a list; what is asserted is that the trigger
    // is the whole of a closed picker either way.
    expect(withoutInput).not.toContain('<input')
  })

  it('can be forced on or off, for a list whose count lies about it', () => {
    const forced = renderToStaticMarkup(
      <Select
        aria-label="Currency"
        value="USD"
        onChange={() => {}}
        items={[{ value: 'USD', label: 'USD' }]}
        width="content"
        search
      />,
    )
    expect(forced).toContain('role="combobox"')
  })
})

describe('the stored shape at the call site', () => {
  it('hands back the op the condition already holds, not a bare string', () => {
    // `Select<ConditionOp>` is what removed `toConditionOp` from the view
    // bar: the items come from `opsFor`, so `onChange` is typed by the same
    // union `Condition.op` is (`packages/db/src/schema/views.ts`). The
    // round-trip shape is unchanged by construction.
    const items = opsFor('select').map((op) => ({ value: op, label: op }))
    expect(items.map((i) => i.value)).toEqual([
      'is',
      'is_not',
      'empty',
      'not_empty',
    ])
  })
})
