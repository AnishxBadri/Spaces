import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OpenInSourceButton } from './document-source.tsx'
import { LinkFetchRow } from './record-files-link.tsx'
import type { LinkFetch } from './record-files-link.tsx'
import { endLane, stateWord } from '#/lib/documents/files-tab'
import { isFolderLink } from '#/lib/documents/storage-link'

/**
 * A Drive file on the Files tab: its end lane says where in Drive it came
 * from and its state lane opens there; a pasted link that has not landed
 * says what it is doing, or why it cannot.
 */

const LINK = 'https://drive.google.com/file/d/pitch/view'

const row = {
  filename: 'Pitch.pdf',
  mime: 'application/pdf',
  sizeBytes: 2048,
  createdAt: '2026-10-07T10:00:00.000Z',
  sourceCapability: 'google-drive',
  sourcePath: null,
  externalUrl: LINK,
  externalStatus: 'linked' as const,
  blobSha: 'a'.repeat(64),
  url: null,
  extractionStatus: 'done',
  extractionError: null,
  lastRun: null,
}

describe('the Drive row', () => {
  it('prints the provider path verbatim, and nothing when there is none', () => {
    expect(endLane({ ...row, sourcePath: 'Data room / Legal' })).toBe(
      'from Data room / Legal · 2.0 KB · 10-07',
    )
    expect(endLane(row)).not.toContain('from')
  })

  it('links out as `drive ↗` rather than naming the plugin twice', () => {
    expect(endLane(row)).not.toContain('via')
    expect(stateWord(row)).toMatchObject({ text: 'drive ↗', href: LINK })
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

describe('a recorder’s recording', () => {
  const RECORDING = 'https://fathom.video/calls/42'

  it('names the recorder in its state lane and opens in it', () => {
    expect(
      stateWord({
        ...row,
        sourceCapability: 'fathom',
        externalUrl: RECORDING,
      }),
    ).toMatchObject({ text: 'fathom ↗', href: RECORDING })
  })

  it('an attachment with no link says which plugin filed it', () => {
    expect(
      endLane({ ...row, sourceCapability: 'gmail', externalUrl: null }),
    ).toBe('2.0 KB · 10-07 · via gmail')
  })

  it('an email attachment names its email, not its mailbox or its subject path', () => {
    expect(
      endLane({
        ...row,
        sourceCapability: 'gmail',
        sourcePath: 'Re: Seed round',
        externalUrl: null,
        email: { subject: 'Re: Seed round' },
      }),
    ).toBe('via Re: Seed round · 2.0 KB · 10-07')
  })
})

describe('LinkFetchRow', () => {
  const render = (state: LinkFetch['state']) =>
    renderToStaticMarkup(
      <LinkFetchRow
        fetch={{
          key: 'k',
          name: LINK,
          label: 'Drive',
          link: true,
          externalUrl: null,
          olderId: null,
          state,
        }}
        onDismiss={() => undefined}
        onLinkFolder={() => undefined}
      />,
    )

  it('reads fetching. while the job runs, with no dismiss', () => {
    const html = render({ kind: 'fetching', fetchId: 'f' })
    expect(html).toContain('fetching.')
    expect(html).not.toContain('Dismiss')
  })

  it('shows the provider’s reason, and Connect Drive when there is no connection', () => {
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
    expect(connect).toContain('Connect your Google Drive to fetch this file.')
  })

  it('refuses a folder link in place and offers Link folder…', () => {
    const folder = 'https://drive.google.com/drive/folders/0Bx'
    expect(isFolderLink(folder)).toBe(true)
    expect(isFolderLink(LINK)).toBe(false)
    const html = render({ kind: 'folder', url: folder })
    expect(html).toContain('Link a Drive folder instead to keep it in sync.')
    expect(html).toContain('Link folder…')
    expect(html).toContain('Dismiss')
  })
})
