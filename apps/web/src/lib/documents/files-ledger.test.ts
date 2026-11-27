import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { FilesFilters, FilesGroup, FilesSort } from './files-filter'

// The test databases carry no `pgboss` schema, and the birth of a document
// enqueues extraction — see `#/test/queue-stub`.
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * The Files page's list query against the test database: unfiled first with
 * its guess, then newest first, the kind tab's filter, the tab counts and
 * each row's first line of text, banded as the page bands them.
 * Imports are dynamic because `@spaces/db` builds its pool from
 * `DATABASE_URL` at import time and the vitest setup rewrites it per file.
 */

async function actor(): Promise<{ id: string; email: string }> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const found = (
    await db.select({ id: user.id, email: user.email }).from(user).limit(1)
  ).at(0)
  if (found === undefined) throw new Error('the seed has no user')
  return found
}

async function aCompany(name: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (ent === undefined) throw new Error('no company')
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

/** A file born with its text read and cut into chunks. */
async function aFile(input: {
  filename: string
  kind: 'deck' | 'legal' | 'article' | 'other'
  chunks: ReadonlyArray<string>
  fileUnder: string | null
  createdAt?: string
}): Promise<string> {
  const { Effect } = await import('effect')
  const { eq } = await import('drizzle-orm')
  const { db } = await import('@spaces/db')
  const { chunk, document } = await import('@spaces/db/schema')
  const { storage } = await import('@spaces/core/writes/storage')
  const { birthDocumentProgram } =
    await import('@spaces/core/writes/documents/birth')
  const { webEnqueue } = await import('#/lib/enqueue-live')
  const bytes = Buffer.from(input.filename, 'utf8')
  const sha = createHash('sha256').update(bytes).digest('hex')
  await storage().put(sha, bytes, { mime: 'application/pdf' })
  const { id } = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: sha,
      filename: input.filename,
      mime: 'application/pdf',
      sizeBytes: bytes.length,
      kind: input.kind,
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst:
        input.fileUnder === null
          ? []
          : [{ kind: 'record', entityId: input.fileUnder }],
      actor: { userId: (await actor()).id },
    }).pipe(Effect.provide(webEnqueue)),
  )
  await db
    .update(document)
    .set({
      extractionStatus: 'done',
      extractedText: input.chunks.join('\n'),
      ...(input.createdAt === undefined
        ? {}
        : { createdAt: new Date(input.createdAt) }),
    })
    .where(eq(document.entityId, id))
  if (input.chunks.length > 0)
    await db.insert(chunk).values(
      input.chunks.map((text, idx) => ({
        entityId: id,
        sourceKind: 'document' as const,
        idx,
        text,
        page: idx + 1,
      })),
    )
  return id
}

type Read = {
  tab?: 'all' | 'legal'
  q?: string
  filters?: Partial<FilesFilters>
  group?: FilesGroup
  sort?: FilesSort
}

async function ledger(tabOrRead: 'all' | 'legal' | Read = {}) {
  const read = typeof tabOrRead === 'string' ? { tab: tabOrRead } : tabOrRead
  const { Effect } = await import('effect')
  const { filesLedgerProgram } = await import('./files-ledger')
  const { NO_FILTERS } = await import('./files-filter')
  return Effect.runPromise(
    filesLedgerProgram({
      viewer: await actor(),
      tab: read.tab ?? 'all',
      limit: 200,
      q: read.q ?? '',
      filters: { ...NO_FILTERS, ...read.filters },
      group: read.group ?? 'date',
      sort: read.sort ?? 'newest',
    }),
  )
}

async function facets(read: Read = {}) {
  const { Effect } = await import('effect')
  const { filesFacetsProgram } = await import('./files-facets')
  const { NO_FILTERS } = await import('./files-filter')
  return Effect.runPromise(
    filesFacetsProgram({
      viewer: await actor(),
      tab: read.tab ?? 'all',
      q: read.q ?? '',
      filters: { ...NO_FILTERS, ...read.filters },
    }),
  )
}

/** Sets columns a born file does not choose: its text, link, state. */
async function setDocument(
  id: string,
  patch: {
    url?: string
    extractedText?: string
    extractionStatus?: 'failed'
    bytesState?: 'remote'
  },
) {
  const { eq } = await import('drizzle-orm')
  const { db } = await import('@spaces/db')
  const { document } = await import('@spaces/db/schema')
  await db.update(document).set(patch).where(eq(document.entityId, id))
}

describe('filesLedgerProgram', () => {
  it('bands unfiled first with its guess, then by day; a kind tab filters; each row leads with its first line', async () => {
    const { dayKey } = await import('@spaces/core/format')
    const { filesBands } = await import('./files-ledger-view')
    const tag = 'ledger-1'
    const flent = await aCompany('Brightwater Nine')
    const deck = await aFile({
      filename: `${tag} deck.pdf`,
      kind: 'deck',
      chunks: [
        '\n  Leases under   management.\nBengaluru and Pune',
        'Page two',
      ],
      fileUnder: flent,
    })
    const old = await aFile({
      filename: `${tag} old.pdf`,
      kind: 'other',
      chunks: ['An older letter'],
      fileUnder: flent,
      createdAt: '2025-03-10T12:00:00.000Z',
    })
    const terms = await aFile({
      filename: `${tag} terms.docx`,
      kind: 'legal',
      chunks: ['Summary of terms between Brightwater Nine and its investors'],
      fileUnder: null,
    })

    const all = await ledger('all')
    const mine = all.rows.filter((r) => r.filename.startsWith(tag))
    expect(mine.map((r) => r.id)).toEqual([terms, deck, old])
    expect(all.counts.all).toBe(all.total)
    expect(all.unfiled).toBeGreaterThanOrEqual(1)

    const [unfiled, newest, oldest] = mine
    expect(unfiled.unfiled).toBe(true)
    expect(unfiled.guess?.target).toEqual({ kind: 'record', entityId: flent })
    expect(unfiled.guess?.name).toBe('Brightwater Nine')
    expect(unfiled.firstLine).toBe(
      'Summary of terms between Brightwater Nine and its investors',
    )
    // The first line of the first chunk, its whitespace collapsed.
    expect(newest.firstLine).toBe('Leases under management.')
    expect(newest.pages).toBe(2)
    expect(newest.records.map((r) => r.id)).toEqual([flent])
    expect(newest.guess).toBeNull()
    expect(oldest.firstLine).toBe('An older letter')

    const bands = filesBands(mine, dayKey(new Date()))
    expect(bands.map((b) => [b.key, b.label, b.rows.map((r) => r.id)])).toEqual(
      [
        ['unfiled', 'Unfiled', [terms]],
        ['today', 'Today', [deck]],
        ['2025-03', 'March 2025', [old]],
      ],
    )

    const legal = await ledger('legal')
    expect(legal.rows.every((r) => r.kind === 'legal')).toBe(true)
    expect(legal.rows.map((r) => r.id)).toContain(terms)
    expect(legal.total).toBe(all.counts.legal)
    expect(legal.counts).toEqual(all.counts)
  })

  it('narrows by each facet, and a chip counts the rows it then shows', async () => {
    const tag = 'ledger-2'
    const acme = await aCompany('Quillon Harbour')
    const deck = await aFile({
      filename: `${tag} deck.pdf`,
      kind: 'deck',
      chunks: ['A deck'],
      fileUnder: acme,
    })
    const sheet = await aFile({
      filename: `${tag} cohorts.xlsx`,
      kind: 'other',
      chunks: ['Cohorts'],
      fileUnder: null,
    })
    await setDocument(sheet, { extractionStatus: 'failed' })
    const page = await aFile({
      filename: `${tag} clipped page`,
      kind: 'article',
      chunks: ['A clipped page'],
      fileUnder: acme,
    })
    await setDocument(page, {
      url: 'https://example.com/a-page',
      bytesState: 'remote',
    })
    const mine = (rows: ReadonlyArray<{ id: string; filename: string }>) =>
      rows.filter((r) => r.filename.startsWith(tag)).map((r) => r.id)

    // Each chip's count, read with nothing on, is the total once it is on.
    const none = await facets()
    const on = [
      [{ type: ['pdf' as const] }, none.type.pdf, [deck]],
      [{ type: ['sheet' as const] }, none.type.sheet, [sheet]],
      [{ type: ['web' as const] }, none.type.web, [page]],
      [{ from: ['link' as const] }, none.from.link, [page]],
      [{ from: ['upload' as const] }, none.from.upload, [deck, sheet]],
      [{ unfiled: true }, none.unfiled, [sheet]],
      [{ look: ['unread' as const] }, none.look.unread, [sheet]],
      [{ look: ['text-only' as const] }, none.look['text-only'], [page]],
    ] as const
    for (const [filters, count, ids] of on) {
      const read = await ledger({ filters })
      expect(read.total).toBe(count)
      expect(read.counts.all).toBe(count)
      expect(mine(read.rows).sort()).toEqual([...ids].sort())
    }
    expect(none.shown).toBe(none.total)

    // Under a record: only its files; the other facets count under it.
    const under = await ledger({ filters: { under: acme } })
    expect(mine(under.rows).sort()).toEqual([deck, page].sort())
    expect(under.named.under).toBe('Quillon Harbour')
    const underFacets = await facets({ filters: { under: acme } })
    expect(underFacets.shown).toBe(2)
    expect(underFacets.type.pdf).toBe(1)
    expect(underFacets.from.link).toBe(1)
    const both = await ledger({ filters: { under: acme, type: ['pdf'] } })
    expect(both.rows.map((r) => r.id)).toEqual([deck])

    // Grouped by record, its band counts every file under it; sorted by
    // name, the unfiled row still leads.
    const grouped = await ledger({ group: 'record', sort: 'name' })
    expect(grouped.groups[acme]).toBe(2)
    const named = mine(grouped.rows)
    expect(named).toEqual([sheet, page, deck])
  })

  it('finds a word inside a deck and names its page, counting every place', async () => {
    const tag = 'ledger-3'
    const deck = await aFile({
      filename: `${tag} deck.pdf`,
      kind: 'deck',
      chunks: [],
      fileUnder: null,
    })
    await setDocument(deck, {
      extractedText: [
        '[Page 1]',
        'Welcome',
        '',
        '[Page 2]',
        'We manage 2,140 Zorbleases across Bengaluru and Pune',
        '',
        '[Page 3]',
        'Nothing here',
        '',
        '[Page 4]',
        'zorbleases again, and zorbleases',
        '',
        '[Page 6]',
        'one more zorblease',
      ].join('\n'),
    })
    const named = await aFile({
      filename: `${tag} zorbleases list.pdf`,
      kind: 'other',
      chunks: ['Nothing that matches'],
      fileUnder: null,
    })

    const read = await ledger({ q: 'zorblease' })
    expect(read.rows.map((r) => r.id).sort()).toEqual([deck, named].sort())
    expect(read.total).toBe(2)
    const hit = read.rows.find((r) => r.id === deck)?.hit
    expect(hit).toEqual({
      total: 4,
      page: 2,
      label: 'p. 2',
      before: 'We manage 2,140 ',
      match: 'Zorblease',
      after: 's across Bengaluru and Pune',
      more: '+3 on p. 4, 6',
    })
    // A file found by its name alone has no hit, and the toolbar's places
    // are the places the rows' hits count.
    expect(read.rows.find((r) => r.id === named)?.hit).toBeNull()
    expect(read.places).toBe(4)
  })
})
