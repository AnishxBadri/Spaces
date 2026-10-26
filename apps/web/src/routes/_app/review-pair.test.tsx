import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { DuplicateCandidateRow, InboxSide } from '#/lib/server-fns'
import { InboxItem } from './review.tsx'

/**
 * The pair card's default keeper: the richer record leads as A, on the left
 * and pre-ticked, and the primary reads "Merge B into A" over that order.
 * The router is stubbed: the card wants `useRouter` and `Link`.
 */
vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<object>('@tanstack/react-router')),
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}))

const side = (over: Partial<InboxSide>): InboxSide => ({
  id: 'side',
  name: 'Side',
  kind: 'company',
  createdAt: '2025-01-01T00:00:00.000Z',
  objectSlug: 'company',
  objectSingular: 'Company',
  sourceClass: 'manual',
  sourceCapability: null,
  label: 'manual',
  domains: [],
  identityDomain: null,
  otherNames: [],
  mentionCount: 0,
  valueCount: 0,
  spaces: [],
  ...over,
})

/** Garuda as the walk found it: A the empty one, B the one with the facts. */
const emptyA = side({
  id: '13876ae8-e4f4-4fa5-bca7-6a3ee8f0ce89',
  name: 'Garuda Autonomy Pvt Ltd',
  createdAt: '2026-09-19T14:41:32.296Z',
})
const richB = side({
  id: 'dcb9b183-9acf-4818-8d0d-c828dc8a9f5f',
  name: 'Garuda Autonomy',
  createdAt: '2024-12-18T05:10:00.000Z',
  domains: ['garudaautonomy.com'],
  valueCount: 8,
  spaces: ['UAS'],
  mentionCount: 1,
})

const pairOf = (a: InboxSide, b: InboxSide): DuplicateCandidateRow => ({
  kind: 'duplicate_candidate',
  id: 'pair-1',
  score: 0.92,
  reason: { name_similarity: 'true' },
  latestAt: '2026-10-11T00:00:00.000Z',
  a,
  b,
})

function render(pair: DuplicateCandidateRow): string {
  return renderToStaticMarkup(
    <ul>
      <InboxItem row={pair} index={0} total={1} />
    </ul>,
  )
}

/** The column heads in order, each as `Keep · A` or `Merge in · B`. */
const heads = (html: string) =>
  [
    ...html.matchAll(
      /aria-pressed="(true|false)"[^>]*>.*?(Keep|Merge in) · ([AB])/g,
    ),
  ].map((m) => `${m[1]} ${m[2]} · ${m[3]}`)

describe('the pair card’s default keeper', () => {
  it('pre-ticks the Garuda record with the domain, the space and the mention, on the left', () => {
    const html = render(pairOf(emptyA, richB))
    expect(heads(html)).toEqual(['true Keep · A', 'false Merge in · B'])
    // The richer record's name is the first one the card prints.
    expect(html.indexOf('>Garuda Autonomy<')).toBeLessThan(
      html.indexOf('>Garuda Autonomy Pvt Ltd<'),
    )
    expect(html.indexOf('garudaautonomy.com')).toBeGreaterThan(-1)
    expect(html).toContain('Merge B into A')
    expect(html).toContain('a snapshot of B is kept')
  })

  it('leaves a tie as it came: A stays A', () => {
    const first = side({ id: 'one', name: 'First Co' })
    const second = side({ id: 'two', name: 'Second Co' })
    const html = render(pairOf(first, second))
    expect(heads(html)).toEqual(['true Keep · A', 'false Merge in · B'])
    expect(html.indexOf('>First Co<')).toBeLessThan(html.indexOf('>Second Co<'))
  })

  it('titles the pair A ⇄ B with why and when, hides a row empty on both sides, and says Dismiss', () => {
    const html = render(pairOf(emptyA, richB))
    expect(html).toContain(
      '<h2 class="min-w-0 truncate font-serif text-lg leading-5.5 font-semibold">Garuda Autonomy ⇄ Garuda Autonomy Pvt Ltd</h2>',
    )
    expect(html).toContain('Names 92% alike · 11 Oct')
    expect(html).toContain('No unmerge · a snapshot of B is kept')
    expect(html).toContain('aria-label="Swap which record stays"')
    // Neither side is seen under another name: the row is not drawn.
    expect(html).not.toContain('Also seen as')
    expect(html).toContain('>Spaces<')
    expect(html).toMatch(/<button[^>]*>Dismiss<\/button>/)
    expect(html).not.toContain('Not the same')
    expect(html).not.toContain('Reject')
    expect(html).not.toContain('shadow-solid')
  })
})
