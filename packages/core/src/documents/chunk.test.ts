import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  MAX_CHARS,
  OVERLAP_CHARS,
  chunk,
  estimateTokens,
  looksLikeHeading,
} from './chunk'
import { extractDocumentText } from './extract'

/**
 * SPA-121. One fixture per format, in the exact shape `extract.ts` leaves
 * the text in, snapshotted whole — the cut *is* the behaviour — plus the
 * properties a snapshot would let drift unnoticed: the size ceiling, the
 * dense 0-based `idx`, and the 40-slide deck arriving as 40 chunks.
 */

/** A deterministic sentence stream, so long fixtures are readable in the snapshot. */
function prose(words: number, seed = 0): string {
  const vocab = [
    'orbital',
    'launch',
    'cadence',
    'revenue',
    'contract',
    'satellite',
    'ground',
    'station',
    'margin',
    'backlog',
    'customer',
    'pipeline',
  ]
  const out: Array<string> = []
  for (let i = 0; i < words; i++) {
    out.push(vocab[(i * 7 + seed) % vocab.length])
    if (i % 12 === 11) out[out.length - 1] += '.'
  }
  return out.join(' ')
}

function invariants(chunks: ReturnType<typeof chunk>) {
  chunks.forEach((c, i) => {
    expect(c.idx).toBe(i)
    expect(c.text.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(c.text.trim()).toBe(c.text)
    expect(c.text).not.toBe('')
  })
}

describe('chunk — pdf, by page', () => {
  const text = [
    '[Page 1]\nVayu Orbital\nSeed round',
    '[Page 2]\nTraction\nARR is $1.2M',
    // Page 3 was a scan with no text layer: extract.ts skipped it.
    `[Page 4]\nMarket\n${prose(420)}`,
    '[Page 5]\nTeam',
  ].join('\n\n')
  const chunks = chunk(text, 'pdf')

  it('matches the snapshot', () => {
    expect(chunks).toMatchSnapshot()
  })

  it('keeps real page numbers and splits only the over-long page', () => {
    invariants(chunks)
    expect(chunks.map((c) => c.page)).toEqual([1, 2, 4, 4, 5])
    // Every piece of the split page still says which page it is.
    expect(
      chunks
        .filter((c) => c.page === 4)
        .every((c) => c.text.startsWith('[Page 4]\n')),
    ).toBe(true)
  })

  it('overlaps across the arbitrary cut inside a page, never across pages', () => {
    const [a, b] = chunks.filter((c) => c.page === 4)
    const tail = b.text.slice('[Page 4]\n'.length, '[Page 4]\n'.length + 40)
    expect(a.text).toContain(tail)
    expect(a.text.length - a.text.lastIndexOf(tail)).toBeLessThanOrEqual(
      OVERLAP_CHARS,
    )
    expect(chunks[1].text).not.toContain('Vayu')
  })

  it('falls back to paragraphs for a PDF extracted before the page markers', () => {
    const legacy = chunk('Vayu Orbital\n\nSeed round', 'pdf')
    expect(legacy).toEqual([
      { idx: 0, text: 'Vayu Orbital\n\nSeed round', page: null },
    ])
  })
})

describe('chunk — pptx, by slide', () => {
  function ooxml(files: Record<string, string>): Uint8Array {
    return zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, xml]) => [path, strToU8(xml)]),
      ),
    )
  }
  const slide = (...runs: Array<string>) =>
    `<?xml version="1.0"?><p:sld xmlns:a="x"><p:cSld><p:spTree>${runs
      .map((r) => `<a:p><a:r><a:t>${r}</a:t></a:r></a:p>`)
      .join('')}</p:spTree></p:cSld></p:sld>`

  it('matches the snapshot, speaker notes staying on their slide', () => {
    const text = [
      '[Slide 1]\nVayu Orbital\nSeed deck',
      '[Slide 2]\nTraction\n[Notes]\nARR is $1.2M as of March',
      '[Slide 3]\nAsk\n$4M on a $20M cap',
    ].join('\n\n')
    const chunks = chunk(text, 'pptx')
    invariants(chunks)
    expect(chunks).toMatchSnapshot()
  })

  it('a 40-slide deck is 40 chunks, one per slide, not one 40-slide blob', async () => {
    const files: Record<string, string> = {}
    for (let n = 1; n <= 40; n++)
      files[`ppt/slides/slide${n}.xml`] = slide(
        `Slide title ${n}`,
        `Point ${n}`,
      )
    const out = await extractDocumentText({
      bytes: ooxml(files),
      filename: 'deck.pptx',
    })
    expect(out.status).toBe('done')
    const chunks = chunk(out.status === 'done' ? out.text : '', 'pptx')
    invariants(chunks)
    expect(chunks).toHaveLength(40)
    expect(chunks.map((c) => c.page)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    )
    expect(chunks[4].text).toBe('[Slide 5]\nSlide title 5\nPoint 5')
  })
})

describe('chunk — xlsx, by sheet then row blocks', () => {
  const rows = Array.from(
    { length: 120 },
    (_, i) =>
      `Holder ${String(i + 1).padStart(3, '0')}\t${(i + 1) * 1000}\t${((i + 1) / 72.6).toFixed(2)}%`,
  )
  const text = [
    `[Cap Table (post)]\nHolder\tShares\tOwnership\n${rows.join('\n')}`,
    '[Summary]\nRound\tPre-money\nSeed\t20000000',
  ].join('\n\n')
  const chunks = chunk(text, 'xlsx')

  it('matches the snapshot', () => {
    expect(chunks).toMatchSnapshot()
  })

  it('repeats the sheet marker and header row on every block, never splits a row', () => {
    invariants(chunks)
    const cap = chunks.filter((c) => c.page === 1)
    expect(cap.length).toBeGreaterThan(1)
    for (const c of cap)
      expect(
        c.text.startsWith('[Cap Table (post)]\nHolder\tShares\tOwnership\n'),
      ).toBe(true)
    const bodyRows = cap.flatMap((c) => c.text.split('\n').slice(2))
    expect(bodyRows).toEqual(rows)
    expect(chunks.at(-1)).toEqual({
      idx: chunks.length - 1,
      text: '[Summary]\nRound\tPre-money\nSeed\t20000000',
      page: 2,
    })
  })
})

describe('chunk — docx, by heading', () => {
  const text = [
    'Investment memo',
    'Summary',
    'Vayu builds orbital transfer vehicles for small satellites.',
    'Team',
    'Two founders from a launch provider; one prior exit.',
    'Market',
    prose(260, 1),
    prose(260, 2),
    'Risks',
    'Launch cadence depends on a single rideshare provider.',
  ].join('\n\n')
  const chunks = chunk(text, 'docx')

  it('matches the snapshot', () => {
    expect(chunks).toMatchSnapshot()
  })

  it('closes a chunk only at a heading, and splits an over-long section under it', () => {
    invariants(chunks)
    expect(chunks.every((c) => c.page === null)).toBe(true)
    // The short opening sections pack together up to the limit.
    expect(chunks[0].text).toContain('Summary\nVayu builds')
    expect(chunks[0].text).toContain('Team\nTwo founders')
    // The long section's pieces each lead with its heading.
    const market = chunks.filter((c) => c.text.startsWith('Market\n'))
    expect(market.length).toBeGreaterThan(1)
    expect(chunks.at(-1)?.text).toBe(
      'Risks\nLaunch cadence depends on a single rideshare provider.',
    )
  })

  it('reads a heading off the paragraph', () => {
    expect(looksLikeHeading('Market')).toBe(true)
    expect(looksLikeHeading('3. Competitive landscape')).toBe(true)
    expect(looksLikeHeading('Revenue grew 3x.')).toBe(false)
    expect(looksLikeHeading('Two lines\nof text')).toBe(false)
    expect(looksLikeHeading('• bullet')).toBe(false)
  })
})

describe('chunk — text', () => {
  it('matches the snapshot: paragraphs packed, the long one split with overlap', () => {
    const text = ['First note.', prose(420, 3), 'Last note.'].join('\n\n')
    const chunks = chunk(text, 'text')
    invariants(chunks)
    expect(chunks).toMatchSnapshot()
  })

  it('answers nothing for empty text', () => {
    expect(chunk('  \n\n ', 'text')).toEqual([])
  })
})

describe('estimateTokens', () => {
  it('is four characters a token, rounded up', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(MAX_CHARS).toBe(2400)
  })
})
