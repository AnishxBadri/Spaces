import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordFiles } from '../record-files'
import { FileRow, removeConfirmOptions } from './file-row'
import { FolderBand } from './folder-band'
import { textLine } from './viewer-sidebar'
import type { RecordDocument } from './types'

/**
 * The Files tab as the printed sheets draw it (D66): our files under their
 * kind, an empty kind left out, every row ending on its end lane and state
 * word, no extracted text; the row's `···` and the Remove confirm saying
 * whether the file leaves the server.
 * - A happy-dom window's DOM globals are installed by hand before React
 *   loads, as `storage-picker.test.tsx` does.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies/flent' })
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'Node',
    'NodeFilter',
    'Element',
    'SVGElement',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'Text',
    'DocumentFragment',
    'ShadowRoot',
    'Event',
    'CustomEvent',
    'UIEvent',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'FocusEvent',
    'MutationObserver',
    'ResizeObserver',
    'DOMRect',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
    Reflect.set(globalThis, key, Reflect.get(win, key))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

const fns = vi.hoisted(() => {
  const names = [
    'attachFromLink',
    'attachFromPicker',
    'clipUrl',
    'deleteDocument',
    'extractKeyTerms',
    'fileDocument',
    'finalizeDocumentUpload',
    'getDocumentDetails',
    'getDocumentDownloadUrl',
    'getDocumentText',
    'getEntitySensitivity',
    'isLaneRouted',
    'keyTermsStatus',
    'linkFetchStatus',
    'listSpaces',
    'markNewerVersion',
    'mintPickerToken',
    'pickerReadiness',
    'prepareDocumentUpload',
    'readDeck',
    'readDeckAndSummarize',
    'readDeckStatus',
    'readWithVision',
    'reExtractDocument',
    'searchEntities',
    'setDocumentKind',
    'summarize',
    'summarizeStatus',
    'unfileDocument',
    'visionStatus',
  ] as const
  return Object.fromEntries(names.map((n) => [n, vi.fn()]))
})

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
  Link: ({ children }: { children: unknown }) => children,
}))

const FLENT = '00000000-0000-4000-8000-000000000001'
const SERIES_A = '00000000-0000-4000-8000-000000000002'

const here = {
  kind: 'record' as const,
  id: FLENT,
  name: 'Flent',
  entityKind: 'company',
  objectSlug: null,
}

function doc(over: Partial<RecordDocument>): RecordDocument {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    filename: 'file.pdf',
    mime: 'application/pdf',
    sizeBytes: 4_300_000,
    kind: 'other',
    extractionStatus: 'done',
    extractionError: null,
    createdAt: '2025-09-02T10:00:00.000Z',
    uploadedBy: null,
    blobSha: '3f9c'.padEnd(60, '0') + 'a21e',
    url: null,
    externalUrl: null,
    externalStatus: null,
    sourcePath: null,
    snippet: 'EXTRACTED SNIPPET TEXT',
    uploadedByName: 'Anish',
    lastRun: null,
    sourceClass: 'manual',
    sourceCapability: null,
    filedIn: [here],
    replacedBy: null,
    email: null,
    ...over,
  }
}

const DOCS: Array<RecordDocument> = [
  doc({ id: 'a1', filename: 'flent-seed-deck-v3.pdf', kind: 'deck' }),
  doc({
    id: 'a2',
    filename: 'flent-seed-deck-v2.pdf',
    kind: 'deck',
    replacedBy: { id: 'a1', name: 'flent-seed-deck-v3.pdf' },
  }),
  doc({
    id: 'a3',
    filename: 'flent-cap-table-sept.xlsx',
    kind: 'cap_table',
    sizeBytes: 43_000,
    createdAt: '2025-09-30T10:00:00.000Z',
    sourceClass: 'integration',
    sourceCapability: 'gmail',
    extractionStatus: 'pending',
  }),
  doc({
    id: 'a4',
    filename: 'bank-statements.pdf',
    kind: 'legal',
    externalStatus: 'gone',
  }),
  doc({
    id: 'a5',
    filename: 'flent-brand-assets.zip',
    kind: 'legal',
    extractionStatus: 'unsupported',
    extractionError: 'no extractable text',
  }),
  doc({
    id: 'a6',
    filename: 'flent-memo.pdf',
    kind: 'legal',
    extractionStatus: 'failed',
    extractionError: 'pdf is encrypted',
    lastRun: {
      status: 'failed',
      attempt: 3,
      durationMs: 1200,
      sinceMs: 60_000,
    },
  }),
]

describe('the grouped tab', () => {
  const html = renderToStaticMarkup(
    <RecordFiles entityId={FLENT} recordName="Flent" documents={DOCS} />,
  )

  it('opens on the add row with the count and size', () => {
    expect(html).toContain('placeholder="Drop files, or paste a Drive link…"')
    expect(html).toContain('6 · ')
    expect(html).toContain('Upload')
    expect(html).toContain('aria-label="More ways to add files"')
  })

  it('groups our files under their kind, in sheet order, and hides an empty kind', () => {
    const deck = html.indexOf('Deck · 2')
    const cap = html.indexOf('Cap table · 1')
    const legal = html.indexOf('Legal · 3')
    expect(deck).toBeGreaterThan(-1)
    expect(cap).toBeGreaterThan(deck)
    expect(legal).toBeGreaterThan(cap)
    expect(html).not.toContain('Diligence ·')
    expect(html).not.toContain('Article ·')
    expect(html).not.toContain('Other ·')
  })

  it('ends each row on its end lane and state word, never the extracted text', () => {
    expect(html).toContain('4.1 MB · 09-02')
    expect(html).toContain('42 KB · 09-30 · via gmail')
    expect(html).toContain('reading text.')
    expect(html).toContain('■ gone')
    expect(html).toContain('no text')
    expect(html).toContain('read failed')
    expect(html).toContain('attempt 3')
    expect(html).not.toContain('EXTRACTED SNIPPET TEXT')
    expect(html).toContain('data-glyph="pdf"')
    expect(html).toContain('data-glyph="xls"')
    expect(html).toContain('data-glyph="zip"')
  })

  it('says a row that is doing nothing with a blank lane', () => {
    const v3 = html.slice(
      html.indexOf('flent-seed-deck-v3.pdf'),
      html.indexOf('flent-seed-deck-v2.pdf'),
    )
    expect(v3).toContain('justify-end mono text-micro"></span>')
  })

  it('dims an older version with the pointer to its successor; the newer reads nothing extra', () => {
    const v2 = html.slice(
      html.indexOf('flent-seed-deck-v2.pdf'),
      html.indexOf('flent-cap-table-sept.xlsx'),
    )
    expect(v2).toContain('Replaced by → flent-seed-deck-v3.pdf')
    expect(v2).toContain('text-graphite')
    const v3 = html.slice(
      html.indexOf('flent-seed-deck-v3.pdf'),
      html.indexOf('flent-seed-deck-v2.pdf'),
    )
    expect(v3).not.toContain('Replaced by')
  })

  it('reads one short line when the tab is empty', () => {
    const empty = renderToStaticMarkup(
      <RecordFiles entityId={FLENT} recordName="Flent" documents={[]} />,
    )
    expect(empty).toContain('No files.')
    expect(empty).not.toContain(' · ')
  })
})

describe('a bound folder', () => {
  it('is its own band with Drive’s tree, read-only', () => {
    const html = renderToStaticMarkup(
      <FolderBand
        recordId={FLENT}
        recordName="Flent"
        onView={() => undefined}
        folder={{
          id: 'b',
          path: 'My Drive / Flent — Data room',
          syncedSinceMs: 4 * 60_000,
          documents: [
            doc({
              id: 'f1',
              filename: 'Audited accounts FY25.pdf',
              sourcePath: 'My Drive / Flent — Data room / Financials',
            }),
            doc({
              id: 'f2',
              filename: 'Flent Series A deck.pdf',
              sourcePath: 'My Drive / Flent — Data room',
            }),
          ],
        }}
      />,
    )
    expect(html).toContain('Flent — Data room')
    expect(html).toContain('2 · synced 4m ago')
    expect(html).toContain('read-only')
    expect(html).toContain('Financials')
    expect(html).toContain('data-glyph="bound-folder"')
    // The tree says where it sits, so the row does not repeat it.
    expect(html).not.toContain('from My Drive')
  })
})

describe('the viewer’s TEXT line', () => {
  it('prints pages and words once read, and what the read is doing before', () => {
    expect(textLine(doc({}), { words: 3812, pages: 14 })).toBe(
      '14 pages read, 3,812 words.',
    )
    expect(textLine(doc({ extractionStatus: 'pending' }), null)).toBe(
      'Reading the text.',
    )
  })
})

describe('the Remove confirm', () => {
  it('says the file leaves the server when it is filed only here', () => {
    const options = removeConfirmOptions(doc({ filename: 'v2.pdf' }), {
      recordId: FLENT,
      recordName: 'Flent',
      mode: 'record',
      chunks: 41,
    })
    expect(options.leaves).toBe(true)
    expect(options.title).toBe('Remove v2.pdf?')
    expect(options.body).toBe(
      'It is filed only on Flent, so it leaves the server.',
    )
    expect(options.rows).toEqual([
      { name: 'Leaves the server', meta: '4.1 MB · 41 chunks' },
    ])
    expect(options.action).toBe('Remove')
  })

  it('keeps it on the server when it is filed elsewhere too', () => {
    const options = removeConfirmOptions(
      doc({
        filedIn: [
          here,
          {
            kind: 'record',
            id: SERIES_A,
            name: 'Flent — Series A',
            entityKind: 'deal',
            objectSlug: null,
          },
        ],
      }),
      { recordId: FLENT, recordName: 'Flent', mode: 'record', chunks: 41 },
    )
    expect(options.leaves).toBe(false)
    expect(options.body).toContain('stays on the server and leaves only Flent')
  })
})

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  vi.clearAllMocks()
  fns.getDocumentDetails.mockResolvedValue({
    chunks: 41,
    words: 100,
    pages: 2,
    sha: null,
    mentionedIn: [],
  })
  fns.deleteDocument.mockResolvedValue({})
  fns.unfileDocument.mockResolvedValue({})
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

async function mountRow(
  row: RecordDocument,
  older: ReadonlyArray<RecordDocument> = [],
) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() =>
    r.render(
      <ul>
        <FileRow
          doc={row}
          recordId={FLENT}
          recordName="Flent"
          older={older}
          onView={() => undefined}
        />
      </ul>,
    ),
  )
  await flush()
}

const byText = (selector: string, text: string) => {
  const found = [...document.querySelectorAll(selector)].find(
    (el) => el.textContent.trim() === text,
  )
  if (found === undefined) throw new Error(`no ${selector} ${text}`)
  return found
}

async function openMenu(name: string) {
  const trigger = document.querySelector(`[aria-label="More for ${name}"]`)
  if (trigger === null) throw new Error('no ··· trigger')
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await flush()
}

async function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

describe('the row’s ···', () => {
  it('holds Open, Download, Change kind and Remove…, and no Newer version of… with nothing to replace', async () => {
    await mountRow(doc({ filename: 'v2.pdf', kind: 'deck' }))
    await openMenu('v2.pdf')
    const items = [...document.querySelectorAll('[role="menuitem"]')].map(
      (el) => el.textContent.trim(),
    )
    expect(items).toEqual(['Open', 'Download', 'Change kind', 'Remove…'])
  })

  it('Newer version of… picks among the same kind and writes the link', async () => {
    fns.markNewerVersion.mockResolvedValue({ written: true })
    const v2 = doc({ id: 'a2', filename: 'v2.pdf', kind: 'deck' })
    await mountRow(doc({ id: 'a3', filename: 'v3.pdf', kind: 'deck' }), [v2])
    await openMenu('v3.pdf')
    const item = byText('[role="menuitem"]', 'Newer version of…')
    expect(item.getAttribute('aria-disabled')).toBeNull()
    await click(item)
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Newer version of…')
    expect(byText('button', 'Mark as newer').hasAttribute('disabled')).toBe(
      true,
    )
    const options = [...document.querySelectorAll('[role="option"]')]
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('v2.pdf'),
    ])
    await click(options[0])
    await click(byText('button', 'Mark as newer'))
    expect(fns.markNewerVersion).toHaveBeenCalledWith({
      data: { newerId: 'a3', olderId: 'a2' },
    })
  })

  it('confirms Remove with what leaves, and deletes a file filed only here', async () => {
    await mountRow(doc({ id: 'a2', filename: 'v2.pdf', kind: 'deck' }))
    await openMenu('v2.pdf')
    await click(byText('[role="menuitem"]', 'Remove…'))
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Remove v2.pdf?')
    expect(dialog?.textContent).toContain(
      'It is filed only on Flent, so it leaves the server.',
    )
    expect(dialog?.textContent).toContain('4.1 MB · 41 chunks')
    expect(byText('button', 'Keep')).toBeDefined()
    await click(byText('button', 'Remove⌘↵'))
    expect(fns.deleteDocument).toHaveBeenCalledWith({ data: { id: 'a2' } })
    expect(fns.unfileDocument).not.toHaveBeenCalled()
  })
})
