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
/** The suggestion lane's kind, arriving without the record or its members. */
const memberlessRow = { kind: 'suggestion', id: 'y' }

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

/**
 * SPA-98. The suggestion lane is the second member, and its card is generic
 * over `suggestion.kind`: a kind with no sub-renderer (every kind but
 * `attribute_patch` today) prints its payload in the same row shape, so the
 * later lanes add a body, not a page. Driven over every value of the
 * database enum, so a kind added there is covered here without an edit.
 */
describe('the suggestion card', () => {
  it('routes the suggestion kind to its own renderer', () => {
    expect(rendererFor('suggestion')).not.toBe(PayloadFallback)
  })

  it('renders every suggestion_kind without throwing', async () => {
    const { suggestionKind } = await import('@spaces/db/schema')
    const { SuggestionEntry, SUGGESTION_KIND_WORD } =
      await import('#/components/inbox/suggestion-card')
    for (const kind of suggestionKind.enumValues) {
      const html = renderToStaticMarkup(
        <ul>
          <SuggestionEntry
            item={{
              id: `s-${kind}`,
              kind,
              payload: { marker: `payload-of-${kind}` },
              rationale: `because ${kind}`,
              citations: [
                {
                  ref: 'doc:x#1',
                  entityId: 'x',
                  label: 'deck.pdf · chunk 1',
                  missing: false,
                },
              ],
              fields: null,
              createdAt: '2026-09-23T00:00:00.000Z',
            }}
            pending={false}
            onAccept={() => {}}
            onReject={() => {}}
          />
        </ul>,
      )
      expect(html).toContain(`because ${kind}`)
      expect(html).toContain('deck.pdf · chunk 1')
      expect(html).toContain('Accept')
      expect(html).toContain('Reject')
      // No sub-renderer, or a patch whose fields could not be read: the
      // payload is what the row shows, under the kind's word.
      expect(html).toContain(`payload-of-${kind}`)
      expect(html).toContain(SUGGESTION_KIND_WORD[kind])
    }
  })

  it('draws an attribute_patch through its fields, not its payload', async () => {
    const { SuggestionEntry } =
      await import('#/components/inbox/suggestion-card')
    const html = renderToStaticMarkup(
      <ul>
        <SuggestionEntry
          item={{
            id: 's-patch',
            kind: 'attribute_patch',
            payload: { founded_year: { value: 2019, refs: [], confidence: 1 } },
            rationale: null,
            citations: [],
            fields: [
              {
                slug: 'founded_year',
                name: 'Founded',
                type: 'number',
                options: null,
                isSystem: true,
                value: 2019,
              },
            ],
            createdAt: '2026-09-23T00:00:00.000Z',
          }}
          pending={false}
          onAccept={() => {}}
          onReject={() => {}}
        />
      </ul>,
    )
    expect(html).toContain('Founded')
    expect(html).toContain('2019')
    expect(html).not.toContain('confidence')
  })

  it('degrades a suggestion row that carries no suggestions', () => {
    const html = renderToStaticMarkup(
      <ul>
        <InboxItem row={memberlessRow} index={0} total={1} />
      </ul>,
    )
    expect(html).toContain('Unrecognized item')
  })
})
