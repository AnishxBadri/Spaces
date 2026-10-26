import { describe, expect, it } from 'vitest'

import type { RecordAction } from '#/lib/server-fns'
import { enrichTitle, enrichToast, offeredActions } from './plugin-actions.tsx'
import type { RecordEnrichView } from './plugin-actions.tsx'

/**
 * The host's Enrich and the plugins' actions, as data: which actions a head
 * offers, what Enrich's tooltip says, and the toast a finished run leaves.
 * The rendered head is `record-heads.test.tsx`'s.
 */

const action = (over: Partial<RecordAction>): RecordAction => ({
  integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000001',
  pluginId: 'apollo',
  pluginName: 'Apollo',
  actionId: 'enrich-company',
  label: 'Enrich',
  queue: 'plugin.apollo.enrichCompany',
  ...over,
})

const view = (over: Partial<RecordEnrichView>): RecordEnrichView => ({
  sources: ['Website'],
  onlyFree: true,
  sensitive: false,
  last: null,
  whereFrom: {},
  parked: null,
  audience: { isAdmin: true, admins: ['Anish'] },
  kind: 'company',
  ...over,
})

describe('offeredActions', () => {
  const similar = action({
    pluginId: 'exa',
    pluginName: 'Exa',
    actionId: 'find-similar',
    label: 'Find similar',
    queue: 'plugin.exa.findSimilar',
  })

  it('drops a source’s own Enrich where the host’s Enrich asks every source', () => {
    expect(offeredActions([action({}), similar], true)).toEqual([similar])
  })

  it('offers everything where no host Enrich runs', () => {
    expect(offeredActions([action({}), similar], false)).toHaveLength(2)
  })
})

describe('enrichTitle', () => {
  it('names the sources it asks, in order', () => {
    expect(enrichTitle(view({ sources: ['Website', 'Apollo'] }))).toBe(
      'Enrich from Website, then Apollo',
    )
  })

  it('says what a sensitive record keeps to', () => {
    expect(enrichTitle(view({ sensitive: true }))).toBe(
      'Enrich from Website · sensitive: Website only',
    )
    expect(enrichTitle(view({ sensitive: true, onlyFree: false }))).toContain(
      'sensitive: local sources only',
    )
  })
})

describe('enrichToast', () => {
  it('says how the run went, and offers Review when it left a card', () => {
    expect(
      enrichToast({
        words: '6 fields · 1 to Review',
        tone: 'done',
        review: true,
      }),
    ).toEqual({
      message: 'Enrich · 6 fields · 1 to Review',
      tone: 'done',
      review: true,
    })
  })

  it('is the error toast when the run failed', () => {
    expect(
      enrichToast({ words: 'timeout', tone: 'bad', review: false }).tone,
    ).toBe('bad')
  })
})
