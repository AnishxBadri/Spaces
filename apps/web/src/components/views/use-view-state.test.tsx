import { useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { VisibilityState } from '@tanstack/react-table'
import type { ViewRow } from '@spaces/core/writes/views/store'
import { useViewState } from './use-view-state'

/**
 * The hook's application of a view, read off a server render.
 * - These tests run on `environment: 'node'` with no DOM, so the page is
 *   a harness whose column state lives beside the hook, as every list page's
 *   `useTablePrefs` does, and the snapshot is rendered as JSON.
 * - A server render settles render-phase updates before it returns, which is
 *   exactly the path a cold `?view=` load takes.
 */

const view = (
  id: string,
  over: Pick<ViewRow, 'columns' | 'sort' | 'filter'>,
): ViewRow => ({
  id,
  surface: 'object',
  objectId: '00000000-0000-4000-8000-0000000000aa',
  name: id,
  extra: {},
  visibility: 'shared',
  createdBy: '00000000-0000-4000-8000-0000000000bb',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const narrow = view('narrow', {
  columns: { stage: false, owner: false },
  sort: { id: 'name', desc: false },
  filter: [{ slug: 'stage', op: 'is', value: 'lead' }],
})
const wide = view('wide', {
  columns: { stage: true, owner: true, notes: false },
  sort: { id: 'created', desc: true },
  filter: [],
})
const views = [narrow, wide]

/** The browser's last local layout, which a view must override. */
const LOCAL: VisibilityState = { notes: true, owner: true }

type Snapshot = {
  filter: unknown
  sort: unknown
  columns: VisibilityState
}

function Harness({
  initial,
  switchTo,
}: {
  initial: string | null
  switchTo?: string
}) {
  const [activeId, setActiveId] = useState<string | null>(initial)
  const [columns, setColumns] = useState<VisibilityState>(LOCAL)
  const vs = useViewState({
    views,
    activeId,
    columnVisibility: columns,
    setColumnVisibility: setColumns,
    defaultExtra: {},
  })
  // Navigate to another view after the first pass, as a click or back/forward would.
  if (switchTo !== undefined && activeId !== switchTo) setActiveId(switchTo)
  return <pre>{JSON.stringify(vs.snapshot)}</pre>
}

function render(props: { initial: string | null; switchTo?: string }) {
  const html = renderToStaticMarkup(<Harness {...props} />)
  const json = html.replace(/^<pre>|<\/pre>$/g, '').replaceAll('&quot;', '"')
  const parsed: Snapshot = JSON.parse(json)
  return parsed
}

describe('useViewState', () => {
  it('applies the view’s columns on the first render of a cold ?view= load', () => {
    const s = render({ initial: 'narrow' })
    expect(s.columns).toEqual(narrow.columns)
    expect(s.sort).toEqual(narrow.sort)
    expect(s.filter).toEqual(narrow.filter)
  })

  it('leaves the local layout alone with no ?view=', () => {
    const s = render({ initial: null })
    expect(s.columns).toEqual(LOCAL)
    expect(s.sort).toBeNull()
    expect(s.filter).toEqual([])
  })

  it('leaves the local layout alone when ?view= names no known view', () => {
    const s = render({ initial: 'gone' })
    expect(s.columns).toEqual(LOCAL)
  })

  it('still applies a view switched to after load', () => {
    const s = render({ initial: 'narrow', switchTo: 'wide' })
    expect(s.columns).toEqual(wide.columns)
    expect(s.sort).toEqual(wide.sort)
    expect(s.filter).toEqual([])
  })
})
