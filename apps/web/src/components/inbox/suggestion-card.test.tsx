import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClockProvider } from '#/components/clock'
import type { SuggestionItem } from '#/lib/server-fns'
import { suggestionBodyFor } from './suggestion-card'

/**
 * An action item's body prints its due day the way every other day in the
 * app is printed, never the stored `YYYY-MM-DD`.
 */

const NOW = '2026-10-28T09:00:00.000Z'

const task = (due: string | null): SuggestionItem => ({
  id: 's1',
  kind: 'task',
  payload: {
    title: 'Send the term sheet',
    due,
    entity_id: '00000000-0000-4000-8000-0000000000c1',
  },
  rationale: null,
  citations: [],
  fields: null,
  origin: { via: 'app' },
  source: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  runId: null,
})

function render(item: SuggestionItem): string {
  const Body = suggestionBodyFor('task')
  return renderToStaticMarkup(
    <ClockProvider now={NOW}>
      <Body item={item} actions={null} />
    </ClockProvider>,
  )
}

describe('a task suggestion', () => {
  it('prints its due day through formatDay', () => {
    const html = render(task('2026-10-25'))
    expect(html).toContain('Send the term sheet')
    expect(html).toContain('>25 Oct</dd>')
    expect(html).not.toContain('2026-10-25')
  })

  it('prints the year on a due day in another year', () => {
    expect(render(task('2027-01-04'))).toContain('>4 Jan 2027</dd>')
  })

  it('prints no Due row on a dateless task', () => {
    expect(render(task(null))).not.toContain('Due')
  })
})
