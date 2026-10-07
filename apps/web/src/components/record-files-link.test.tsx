import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OpenInSourceButton } from './document-source.tsx'
import { fileMeta } from './record-files.tsx'
import { LinkFetchRow } from './record-files-link.tsx'
import type { LinkFetch } from './record-files-link.tsx'

/**
 * A Drive file on the Files tab: its row says where in Drive it came from
 * and opens there; a pasted link that has not landed says what it is doing,
 * or why it cannot.
 */

const LINK = 'https://drive.google.com/file/d/pitch/view'

const row = {
  kind: 'legal' as const,
  sizeBytes: 2048,
  createdAt: '2026-10-07T10:00:00.000Z',
  uploadedByName: 'Anish',
  sourceCapability: 'google-drive',
  sourcePath: null,
}

describe('the Drive row', () => {
  it('prints the provider path verbatim, and nothing when there is none', () => {
    expect(fileMeta({ ...row, sourcePath: 'Data room / Legal' })).toContain(
      ' · via google-drive · from Data room / Legal',
    )
    expect(fileMeta(row)).not.toContain('from')
  })

  it('opens a Drive link as Open in Drive, any other as Open in source', () => {
    const drive = renderToStaticMarkup(
      <OpenInSourceButton url={LINK} filename="Pitch.pdf" />,
    )
    expect(drive).toContain('title="Open in Drive"')
    expect(drive).toContain(`href="${LINK}"`)
    const other = renderToStaticMarkup(
      <OpenInSourceButton url="https://box.com/f/1" filename="Pitch.pdf" />,
    )
    expect(other).toContain('title="Open in source"')
  })
})

describe('LinkFetchRow', () => {
  const render = (state: LinkFetch['state']) =>
    renderToStaticMarkup(
      <LinkFetchRow
        fetch={{ key: 'k', url: LINK, label: 'Drive', state }}
        onDismiss={() => undefined}
      />,
    )

  it('reads Fetching from Drive while the job runs, with no dismiss', () => {
    const html = render({ kind: 'fetching', fetchId: 'f' })
    expect(html).toContain('Fetching from Drive…')
    expect(html).not.toContain('Dismiss')
  })

  it('shows the provider’s reason, and Connect when there is no connection', () => {
    expect(
      render({ kind: 'refused', reason: 'Invalid Credentials' }),
    ).toContain('Invalid Credentials')
    const connect = render({
      kind: 'connect',
      href: '/api/connections/google/start?product=drive',
      action: 'Connect Drive',
    })
    expect(connect).toContain(
      'href="/api/connections/google/start?product=drive"',
    )
    expect(connect).toContain('Connect Drive')
  })
})
