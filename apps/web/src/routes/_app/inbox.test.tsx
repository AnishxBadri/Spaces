import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { InboxItem, PayloadFallback, rendererFor } from './inbox.tsx'

/**
 * SPA-76. The review inbox is a queue over typed rows, and the renderer map
 * is the whole contract: a later lane adds a member to `InboxRow` and a
 * renderer keyed by its `kind`, never a second page. What has to hold for
 * that to be safe is the miss — a row whose kind this build has no renderer
 * for must print its payload and leave the rest of the list standing.
 *
 * Asserted over the dispatch rather than the page: `PairCard` wants a router
 * (`useRouter`, `Link`) and the suite runs on `environment: 'node'` with no
 * DOM, while the fallback is plain markup. `renderToStaticMarkup` is the
 * same server render the app ships through (`select.test.tsx`).
 */

/** Rows from a build that knows lanes this one does not. */
const ledgerRow = {
  kind: 'ledger_event',
  id: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000001',
  payload: { amount: 250000, currency: 'USD' },
}
const kpiRow = {
  kind: 'kpi_observation',
  id: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000002',
  payload: { metric: 'arr', value: 42 },
}
/** A kind the map *does* know, arriving without the pair the card needs. */
const pairlessRow = { kind: 'duplicate_candidate', id: 'x' }

describe('the inbox renderer map', () => {
  it('routes a known kind to its own renderer, not the fallback', () => {
    expect(rendererFor('duplicate_candidate')).not.toBe(PayloadFallback)
  })

  it('falls back for a kind no renderer is registered for', () => {
    expect(rendererFor('ledger_event')).toBe(PayloadFallback)
    expect(rendererFor('')).toBe(PayloadFallback)
  })

  it('prints the unknown row rather than throwing', () => {
    const html = renderToStaticMarkup(
      <ul>
        <InboxItem row={ledgerRow} index={0} total={1} />
      </ul>,
    )
    expect(html).toContain('ledger_event')
    expect(html).toContain('250000')
    expect(html).toContain('Unrecognized item')
  })

  it('leaves the rest of the list standing — two misses, two cards', () => {
    const rows = [ledgerRow, kpiRow]
    const html = renderToStaticMarkup(
      <ul>
        {rows.map((row, i) => (
          <InboxItem key={row.id} row={row} index={i} total={rows.length} />
        ))}
      </ul>,
    )
    expect(html).toContain('ledger_event')
    expect(html).toContain('kpi_observation')
    expect(html.match(/Unrecognized item/g)).toHaveLength(2)
  })

  it('degrades a duplicate_candidate row that carries no pair', () => {
    // The renderer is registered, so the map hits — and the row still has
    // no `a`/`b`. It prints rather than crashing the list.
    const html = renderToStaticMarkup(
      <ul>
        <InboxItem row={pairlessRow} index={0} total={1} />
      </ul>,
    )
    expect(html).toContain('Unrecognized item')
  })
})
