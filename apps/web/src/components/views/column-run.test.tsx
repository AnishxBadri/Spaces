import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { columnRunStatusLine } from '#/components/inbox/column-run-group'
import { PayloadFallback, rendererFor } from '#/routes/_app/inbox.tsx'
import { columnRunConfirm, useColumnRun } from './column-run'

/**
 * SPA-122, the client half: the column header offers "Run on this view"
 * only on an attribute that carries `options.ai`, and only over a saved
 * view; the confirm shows the estimate, or the refusal with no button; the
 * inbox has a renderer for the run's group.
 */

const whyNow: RegistryEntry = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'why_now',
  name: 'Why now?',
  type: 'text',
  isSystem: false,
  options: {
    ai: { mode: 'prompt', prompt: 'Why now?', lane: 'synthesize' },
  },
}
const vintage: RegistryEntry = {
  id: '00000000-0000-4000-8000-000000000002',
  slug: 'vintage',
  name: 'Vintage',
  type: 'number',
  isSystem: false,
  options: {},
}

function Offers({
  viewId,
  columnId,
}: {
  viewId: string | null
  columnId: string
}) {
  const { columnActions } = useColumnRun({
    viewId,
    registry: [whyNow, vintage],
  })
  return (
    <span>
      {columnActions(columnId)
        .map((a) => a.label)
        .join('|') || 'nothing'}
    </span>
  )
}

const offers = (viewId: string | null, columnId: string) =>
  renderToStaticMarkup(<Offers viewId={viewId} columnId={columnId} />)

describe('the column header', () => {
  const VIEW = '00000000-0000-4000-8000-0000000000aa'

  it('offers "Run on this view" on an AI-configured attribute over a saved view', () => {
    expect(offers(VIEW, 'attr:why_now')).toContain('Run on this view')
  })

  it('offers nothing on an attribute without ai config, a core column, or with no saved view', () => {
    expect(offers(VIEW, 'attr:vintage')).toContain('nothing')
    expect(offers(VIEW, 'name')).toContain('nothing')
    expect(offers(null, 'attr:why_now')).toContain('nothing')
  })
})

describe('the confirm', () => {
  it('shows the estimate and a button that names the calls', () => {
    const o = columnRunConfirm('Why now?', {
      ok: true,
      viewName: 'Screening · Bay Area',
      attributeName: 'Why now?',
      total: 30,
      proposed: 2,
      calls: 28,
      perCall: { tokens: 1200, from: 'attribute' },
      tokens: 33600,
    })
    expect(o.action).toBe('Run 28')
    expect(o.rows?.map((r) => r.meta)).toEqual([
      '30',
      '2',
      '~28',
      '~33,600 · from its last run',
    ])
  })

  it('a refused view says why and offers no button', () => {
    const o = columnRunConfirm('Why now?', {
      ok: false,
      reason: 'It filters on “Vintage”, which is archived',
    })
    expect(o.action).toBeUndefined()
    expect(o.body).toContain('archived')
  })

  it('an unknown cost reads unknown, not zero', () => {
    const o = columnRunConfirm('Why now?', {
      ok: true,
      viewName: 'All',
      attributeName: 'Why now?',
      total: 3,
      proposed: 0,
      calls: 3,
      perCall: null,
      tokens: null,
    })
    expect(o.rows?.at(-1)?.meta).toBe('unknown')
  })
})

describe('the inbox group', () => {
  it('has its own renderer', () => {
    expect(rendererFor('column_run')).not.toBe(PayloadFallback)
  })

  it('summarizes where the run stands', () => {
    expect(columnRunStatusLine({ status: 'failed', rowsRun: 12 }, 12)).toBe(
      'stopped · 12 rows run · 12 waiting',
    )
    expect(columnRunStatusLine({ status: 'running', rowsRun: 1 }, 1)).toBe(
      'running · 1 row run so far · 1 waiting',
    )
  })
})
