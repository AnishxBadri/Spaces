import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

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
  kind: 'deck' | 'legal' | 'other'
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

async function ledger(tab: 'all' | 'legal') {
  const { Effect } = await import('effect')
  const { filesLedgerProgram } = await import('./files-ledger')
  return Effect.runPromise(
    filesLedgerProgram({ viewer: await actor(), tab, limit: 50, q: '' }),
  )
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
})
