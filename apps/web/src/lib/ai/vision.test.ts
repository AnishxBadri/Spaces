import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import type { QueuedJob } from '#/lib/queue'
import {
  VISION_PAGES_PER_CHUNK,
  loadPdf,
  pageRanges,
  pageSections,
  visionChunks,
  visionStatusOf,
  visionText,
} from './vision'

/**
 * SPA-94, the pure half of the vision lane: the chunk bound, the page-range
 * cut, and the answer read back into extraction's `[Page N]` shape. The job
 * that calls the model is `worker/jobs/vision-document.test.ts`.
 */

describe('the chunk bound', () => {
  it('is twenty pages a request', () => {
    expect(VISION_PAGES_PER_CHUNK).toBe(20)
  })

  it('cuts a 200-page scan into ten ranges, the last one short when it must be', () => {
    const ranges = pageRanges(200)
    expect(ranges).toHaveLength(10)
    expect(ranges.at(0)).toEqual({ first: 1, last: 20 })
    expect(ranges.at(-1)).toEqual({ first: 181, last: 200 })
    expect(pageRanges(41)).toEqual([
      { first: 1, last: 20 },
      { first: 21, last: 40 },
      { first: 41, last: 41 },
    ])
    expect(pageRanges(0)).toEqual([])
  })

  it('yields one range at a time, each a PDF of just those pages', async () => {
    const src = await PDFDocument.create()
    for (let i = 0; i < 5; i++) src.addPage([200 + i, 300])
    const loaded = await loadPdf(await src.save())

    const chunks = visionChunks(loaded, 2)
    const seen: Array<{ first: number; pages: number; width: number }> = []
    for await (const { range, bytes } of chunks) {
      const part = await PDFDocument.load(bytes)
      seen.push({
        first: range.first,
        pages: part.getPageCount(),
        width: part.getPage(0).getWidth(),
      })
    }
    expect(seen).toEqual([
      { first: 1, pages: 2, width: 200 },
      { first: 3, pages: 2, width: 202 },
      { first: 5, pages: 1, width: 204 },
    ])
  })
})

describe('reading the answer back', () => {
  it('keeps pages numbered inside the range, as written', () => {
    expect(
      pageSections('[Page 21]\nalpha\n\n[Page 22]\nbeta', {
        first: 21,
        last: 22,
      }),
    ).toEqual([
      { page: 21, text: 'alpha' },
      { page: 22, text: 'beta' },
    ])
  })

  it('reads 1…n as relative to a range that starts later', () => {
    expect(
      pageSections('[Page 1]\nalpha\n[Page 2]\nbeta', { first: 21, last: 22 }),
    ).toEqual([
      { page: 21, text: 'alpha' },
      { page: 22, text: 'beta' },
    ])
  })

  it('gives unmarked text to the first page, drops fences and empty pages', () => {
    expect(
      pageSections('```\nCover\n[Page 2]\n\n[Page 3]\nthird\n```', {
        first: 1,
        last: 3,
      }),
    ).toEqual([
      { page: 1, text: 'Cover' },
      { page: 3, text: 'third' },
    ])
  })

  it('writes the extractor’s shape: [Page N] sections, blank-line joined', () => {
    expect(
      visionText([
        { page: 1, text: 'a' },
        { page: 3, text: 'c' },
      ]),
    ).toBe('[Page 1]\na\n\n[Page 3]\nc')
  })
})

describe('the button’s status', () => {
  const job = (
    state: QueuedJob['state'],
    at: number,
    output: object | null = null,
  ): QueuedJob => ({
    state,
    createdOn: new Date(at),
    output,
  })

  it('reads the latest job', () => {
    expect(visionStatusOf([])).toEqual({ state: 'idle' })
    expect(visionStatusOf([job('active', 2), job('failed', 1)])).toEqual({
      state: 'reading',
    })
    expect(
      visionStatusOf([
        job('failed', 2, { reason: 'Anthropic did not answer' }),
      ]),
    ).toEqual({
      state: 'failed',
      message: 'Anthropic did not answer',
      at: new Date(2).toISOString(),
    })
  })
})
