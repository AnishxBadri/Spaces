import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Effect, Exit, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  company,
  document,
  entity,
  integration,
  link,
  user,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { Content } from '@spaces/sdk'
import type { DocumentClaim } from '@spaces/sdk'
import type * as Documents from '../../documents'
import { QUEUES } from '../../queue/names'
import { Enqueue } from '../../queue/enqueue'
import { birthDocumentProgram } from '../documents/birth'
import { prepareBlobUploadProgram } from '../documents/prepare'
import { storage } from '../storage'
import { ContentLive } from './content'

/**
 * `Content.fileDocument` bound to an integration row (sdk-8, SPA-203),
 * against a real database and the real blob store: the port is a thin
 * shell over core's intake, so every assertion here is about a row, a blob
 * or a queued job that intake and birth produced — the port only chose the
 * provenance.
 *
 * The limit is lowered for this file. `intake.test.ts` proves the meter at
 * the real 250 MB; what this file proves is that a plugin's stream reaches
 * that meter, and a quarter-gigabyte fixture would only prove it slower. The
 * claim has no size field, so nothing a plugin sends can move the number.
 */
const LIMIT = 64 * 1024
vi.mock('../../documents', async (original) => ({
  ...(await original<typeof Documents>()),
  MAX_UPLOAD_BYTES: 64 * 1024,
}))

/** What birth handed the queue, and whether the row was readable by then. */
const enqueued = new Array<{
  name: string
  data: Record<string, unknown>
  rowVisible: boolean
}>()
let queueDown = false

/**
 * A recording `Enqueue` that reads the row back through the pool before
 * answering: a row visible from another connection at enqueue time is a row
 * whose transaction had committed. `queueDown` answers `null`, the
 * contract's "could not send".
 */
const RecordingEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (name, data) =>
      Effect.promise(async () => {
        const id = typeof data.documentId === 'string' ? data.documentId : ''
        const seen = await db
          .select({ id: document.entityId })
          .from(document)
          .where(eq(document.entityId, id))
        enqueued.push({ name, data, rowVisible: seen.length === 1 })
        return queueDown ? null : `job-${enqueued.length}`
      }),
  }),
)

beforeEach(() => {
  enqueued.length = 0
  queueDown = false
})

const boundRow = async (capabilityId = 'importer') => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '1.0.0', enabled: true })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const aCompany = async (name: string) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no entity')
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

const fileDocument = (
  row: { id: string; capabilityId: string },
  claim: DocumentClaim,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* Content).fileDocument(claim)
    }).pipe(
      Effect.provide(ContentLive(row).pipe(Layer.provide(RecordingEnqueue))),
    ),
  )

const filed = async (
  row: { id: string; capabilityId: string },
  claim: DocumentClaim,
) => {
  const exit = await fileDocument(row, claim)
  if (Exit.isFailure(exit)) throw new Error(JSON.stringify(exit))
  return exit.value
}

/** Bytes that read as a PDF header and are unique to the phrase. */
const pdfLike = (phrase: string) =>
  new Uint8Array(Buffer.from(`%PDF-1.4\n% ${phrase}\n%%EOF\n`, 'utf8'))

const shaOf = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

/** A web stream over the bytes, in small chunks, recording a cancel. */
const webStream = (bytes: Uint8Array, chunk = 7) => {
  let at = 0
  const state = { cancelled: false }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(at, at + chunk))
      at += chunk
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { stream, state }
}

/** A provider that never stops sending. */
const endlessStream = () => {
  const state = { cancelled: false, sent: 0 }
  const block = new Uint8Array(16 * 1024).fill(0x41)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.sent += block.length
      controller.enqueue(block)
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { stream, state }
}

const documentRow = async (id: string) =>
  (
    await db
      .select({
        blobSha: document.blobSha,
        filename: document.filename,
        kind: document.kind,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        sourceClass: document.sourceClass,
        sourceRef: document.sourceRef,
        uploadedBy: document.uploadedBy,
        extractionStatus: document.extractionStatus,
      })
      .from(document)
      .where(eq(document.entityId, id))
  ).at(0)

const taggedIn = async (documentId: string) =>
  (
    await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(
        and(eq(link.fromEntityId, documentId), eq(link.relation, 'tagged_in')),
      )
  ).map((r) => r.to)

const intakeTempDirs = async () =>
  (await readdir(tmpdir()).catch(() => [])).filter((n) =>
    n.startsWith('spaces-intake-'),
  )

describe('Content.fileDocument, bound to an integration row', () => {
  it('files bytes against a company as the integration: no user, the ref set, extraction queued after commit', async () => {
    const tag = randomUUID().slice(0, 8)
    const row = await boundRow()
    const acme = await aCompany(`Acme ${tag}`)
    const bytes = pdfLike(`acme deck ${tag}`)

    const { documentId } = await filed(row, {
      _tag: 'document',
      body: { bytes },
      filename: `acme-${tag}.pdf`,
      mime: 'application/pdf',
      kind: 'deck',
      fileAgainst: [{ kind: 'record', entityId: acme }],
    })

    expect(await documentRow(documentId)).toEqual({
      blobSha: shaOf(bytes),
      filename: `acme-${tag}.pdf`,
      kind: 'deck',
      mime: 'application/pdf',
      sizeBytes: bytes.byteLength,
      sourceClass: 'integration',
      sourceRef: row.id,
      uploadedBy: null,
      extractionStatus: 'pending',
    })
    expect(await storage().exists(shaOf(bytes))).toBe(true)
    expect(await taggedIn(documentId)).toEqual([acme])

    // The document's own entity row carries the same provenance and no user.
    const ent = (
      await db
        .select({
          sourceClass: entity.sourceClass,
          sourceRef: entity.sourceRef,
          createdBy: entity.createdBy,
        })
        .from(entity)
        .where(eq(entity.id, documentId))
    ).at(0)
    expect(ent).toEqual({
      sourceClass: 'integration',
      sourceRef: row.id,
      createdBy: null,
    })

    // One activity line, on the company, with no user and the integration
    // in `meta` — what the record timeline names the plugin by.
    const lines = await db
      .select({
        actorId: activity.actorId,
        subject: activity.subjectEntityId,
        meta: activity.meta,
      })
      .from(activity)
      .where(
        and(
          eq(activity.verb, 'document.filed'),
          eq(activity.objectEntityId, documentId),
        ),
      )
    expect(lines).toEqual([
      {
        actorId: null,
        subject: acme,
        meta: {
          filename: `acme-${tag}.pdf`,
          kind: 'deck',
          targets: 1,
          actorType: 'integration',
          integrationId: row.id,
        },
      },
    ])

    // Queued through core's Enqueue, and only once the row was committed.
    expect(enqueued).toEqual([
      {
        name: QUEUES.extractDocument,
        data: { documentId },
        rowVisible: true,
      },
    ])

    await storage().delete(shaOf(bytes))
  })

  it('drains a web stream through intake, hashing what arrived', async () => {
    const tag = randomUUID().slice(0, 8)
    const row = await boundRow()
    const acme = await aCompany(`Streamed ${tag}`)
    const bytes = pdfLike(`streamed ${tag} `.repeat(40))
    const { stream, state } = webStream(bytes)

    const { documentId } = await filed(row, {
      _tag: 'document',
      body: { stream },
      filename: `streamed-${tag}.pdf`,
      mime: 'application/pdf',
      fileAgainst: [{ kind: 'record', entityId: acme }],
    })

    expect(await documentRow(documentId)).toMatchObject({
      blobSha: shaOf(bytes),
      sizeBytes: bytes.byteLength,
      // Omitted → other; the classifier may propose better.
      kind: 'other',
    })
    // Read to the end, not cancelled.
    expect(state.cancelled).toBe(false)
    await storage().delete(shaOf(bytes))
  })

  it('the same sha filed by the plugin then uploaded by hand is one row and one blob', async () => {
    const tag = randomUUID().slice(0, 8)
    const row = await boundRow()
    const acme = await aCompany(`Dedupe ${tag}`)
    const bytes = pdfLike(`dedupe ${tag}`)
    const sha = shaOf(bytes)
    const put = vi.spyOn(storage(), 'put')

    const { documentId } = await filed(row, {
      _tag: 'document',
      body: { bytes },
      filename: `deck-${tag}.pdf`,
      mime: 'application/pdf',
      kind: 'deck',
      fileAgainst: [{ kind: 'record', entityId: acme }],
    })

    // The hand upload, as apps/web's lane runs it: prepare (the browser's
    // digest), then — with nothing to PUT — finalize's birth as a person.
    const person = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!person) throw new Error('no fixture user')
    const prepared = await Effect.runPromise(
      prepareBlobUploadProgram({
        sha,
        sizeBytes: bytes.byteLength,
        preparedBy: person.id,
      }),
    )
    expect(prepared.alreadyStored).toBe(true)
    const hand = await Effect.runPromise(
      birthDocumentProgram({
        blobSha: sha,
        filename: `deck-${tag}.pdf`,
        mime: 'application/pdf',
        sizeBytes: bytes.byteLength,
        kind: 'deck',
        sourceClass: 'manual',
        sourceRef: null,
        provenance: {},
        fileAgainst: [{ kind: 'record', entityId: acme }],
        actor: { userId: person.id },
      }).pipe(Effect.provide(RecordingEnqueue)),
    )

    expect(hand).toEqual({ id: documentId, deduped: true })
    const rows = await db
      .select({ id: document.entityId })
      .from(document)
      .where(eq(document.blobSha, sha))
    expect(rows).toEqual([{ id: documentId }])
    expect(put).toHaveBeenCalledTimes(1)
    // The plugin's provenance stands; the dedupe added nothing to it.
    expect(await documentRow(documentId)).toMatchObject({
      sourceClass: 'integration',
      sourceRef: row.id,
      uploadedBy: null,
    })

    put.mockRestore()
    await storage().delete(sha)
  })

  it('a stream past MAX_UPLOAD_BYTES fails permanently, cancels the source and stores nothing', async () => {
    const tag = randomUUID().slice(0, 8)
    const row = await boundRow()
    const acme = await aCompany(`Runaway ${tag}`)
    const put = vi.spyOn(storage(), 'put')
    const before = await intakeTempDirs()
    const { stream, state } = endlessStream()

    const exit = await fileDocument(row, {
      _tag: 'document',
      body: { stream },
      filename: `runaway-${tag}.bin`,
      mime: 'application/octet-stream',
      fileAgainst: [{ kind: 'record', entityId: acme }],
    })

    expect(Exit.isFailure(exit)).toBe(true)
    const text = JSON.stringify(exit)
    expect(text).toContain('JobPermanent')
    expect(text).toContain('Larger than the 64 KB limit')
    expect(state.sent).toBeGreaterThan(LIMIT)
    expect(state.cancelled).toBe(true)
    expect(put).not.toHaveBeenCalled()
    expect(await intakeTempDirs()).toEqual(before)
    expect(enqueued).toEqual([])
    expect(
      await db
        .select({ id: document.entityId })
        .from(document)
        .where(eq(document.filename, `runaway-${tag}.bin`)),
    ).toEqual([])

    // Bytes in hand past the limit are refused before a byte is read.
    const big = new Uint8Array(LIMIT + 1)
    const refused = await fileDocument(row, {
      _tag: 'document',
      body: { bytes: big },
      filename: `big-${tag}.bin`,
      mime: null,
      fileAgainst: [],
    })
    expect(JSON.stringify(refused)).toContain('JobPermanent')
    expect(put).not.toHaveBeenCalled()
    expect(await storage().exists(shaOf(big))).toBe(false)

    put.mockRestore()
  })

  it('a down queue leaves a readable document at extraction_status pending', async () => {
    const tag = randomUUID().slice(0, 8)
    const row = await boundRow()
    const acme = await aCompany(`Queue down ${tag}`)
    const bytes = pdfLike(`queue down ${tag}`)
    queueDown = true

    const { documentId } = await filed(row, {
      _tag: 'document',
      body: { bytes },
      filename: `down-${tag}.pdf`,
      mime: 'application/pdf',
      fileAgainst: [{ kind: 'record', entityId: acme }],
    })

    expect(enqueued).toHaveLength(1)
    expect(await documentRow(documentId)).toMatchObject({
      extractionStatus: 'pending',
      sourceRef: row.id,
    })
    expect(await taggedIn(documentId)).toEqual([acme])
    await storage().delete(shaOf(bytes))
  })

  it('files against the survivor of a merged record, and refuses a target that names nothing', async () => {
    const tag = randomUUID().slice(0, 8)
    const row = await boundRow()
    const winner = await aCompany(`Winner ${tag}`)
    const loser = await aCompany(`Loser ${tag}`)
    await db
      .update(entity)
      .set({ mergedIntoId: winner })
      .where(eq(entity.id, loser))
    const bytes = pdfLike(`merged ${tag}`)

    const { documentId } = await filed(row, {
      _tag: 'document',
      body: { bytes },
      filename: `merged-${tag}.pdf`,
      mime: 'application/pdf',
      fileAgainst: [{ kind: 'record', entityId: loser }],
    })
    expect(await taggedIn(documentId)).toEqual([winner])
    await storage().delete(shaOf(bytes))

    const { stream, state } = webStream(pdfLike(`nowhere ${tag}`))
    const exit = await fileDocument(row, {
      _tag: 'document',
      body: { stream },
      filename: `nowhere-${tag}.pdf`,
      mime: 'application/pdf',
      fileAgainst: [
        { kind: 'record', entityId: '00000000-0000-4000-8000-000000000000' },
      ],
    })
    expect(JSON.stringify(exit)).toContain('JobPermanent')
    // Refused before intake: the plugin's source is released, not left open.
    expect(state.cancelled).toBe(true)

    const blank = await fileDocument(row, {
      _tag: 'document',
      body: { bytes },
      filename: '   ',
      mime: null,
      fileAgainst: [],
    })
    expect(JSON.stringify(blank)).toContain('JobPermanent')
  })
})

/**
 * The port has no pipeline of its own (D52, sdk-8): the workspace-rooted
 * greps in `../documents/intake.test.ts` already hold `insert(document)` and
 * `storage().put(` to their one site each; this names the port's own source
 * so a copied hash or a reached-for store fails here, beside it.
 */
describe('the port is a shell over intake', () => {
  const source = readFileSync(new URL('./content.ts', import.meta.url), 'utf8')

  it('writes no document row, hashes no bytes and never touches the store', () => {
    expect(source).not.toContain('insert(document)')
    expect(source).not.toContain('createHash')
    expect(source).not.toContain('storage()')
    expect(source).not.toMatch(/from '\.\.\/storage/)
  })

  it('hands the bytes to intakeDocumentProgram', () => {
    expect(source).toContain('intakeDocumentProgram({')
  })
})
