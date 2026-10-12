import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NewerVersionSelect } from './newer-version-select'

/** The one "Newer version of" field the three adding surfaces share. */

const DECK = {
  id: '6b1f7c1e-0000-4000-8000-000000000002',
  filename: 'Seed deck v2.pdf',
  kind: 'deck' as const,
  createdAt: '2026-09-15T10:00:00.000Z',
}

const render = (value: string | null, candidates = [DECK]) =>
  renderToStaticMarkup(
    <NewerVersionSelect
      candidates={candidates}
      value={value}
      onChange={() => undefined}
    />,
  )

describe('NewerVersionSelect', () => {
  it('renders nothing when no file of the kind is on the record', () => {
    expect(render(null, [])).toBe('')
  })

  it('defaults to none', () => {
    const html = render(null)
    expect(html).toContain('Newer version of')
    expect(html).toContain('None')
    expect(html).not.toContain('Seed deck v2.pdf')
  })

  it('shows the picked file', () => {
    expect(render(DECK.id)).toContain('Seed deck v2.pdf')
  })
})
