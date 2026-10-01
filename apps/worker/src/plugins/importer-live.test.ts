import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { document, integration, link, user } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { birthDocumentProgram } from '@spaces/core/writes/documents/birth'
import { prepareBlobUploadProgram } from '@spaces/core/writes/documents/prepare'
import { ContentLive } from '@spaces/core/writes/ports/content'
import { IdentityLive } from '@spaces/core/writes/ports/identity'
import { LogLive } from '@spaces/core/writes/ports/log'
import { storage } from '@spaces/core/writes/storage'
import type { FileInput, JobError, PortService } from '@spaces/sdk'
import { JobContext } from '../run-job'
import { ExtractionStore, extractDocument } from '../jobs/extract-document'
import { reconcilePlugins } from './loader'

/**
 * The importer fixture's `importDeck` job — the real bundle, loaded by the
 * loader exactly as boot loads it — run once on the **live** ports over the
 * test database (sdk-8, SPA-203): `Content.fileDocument` is core's intake,
 * so the fixture PDF lands as a blob and a `document` row filed against the
 * company with the integration's provenance, birth queues extraction after
 * the commit, the existing `extract-document` job reads its text, and the
 * identical file uploaded by hand afterwards dedupes to the same row. This
 * is the demo the orchestrator repeats against the dev database.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const FILENAME = 'acme-fusion.example__series-a-deck.pdf'
const pdf = readFileSync(path.join(fixtures, 'importer/fixtures', FILENAME))

type ImportServices = PortService<'Identity' | 'Content' | 'Log'>
type ImportDeck = (
  input: FileInput,
) => Effect.Effect<void, JobError, ImportServices>

/** The loaded job is `unknown` until sdk-12b wires it; this is its shape. */
const isImportDeck = (job: unknown): job is ImportDeck =>
  typeof job === 'function'

const loadImporter = async () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-importer-')),
    'plugins',
  )
  const dir = path.join(root, 'importer', 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(path.join(fixtures, 'importer', 'dist', file), path.join(dir, file))
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'importer', version: '0.1.0', enabled: true })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root }),
  )
  const job = loaded.at(0)?.jobs.importDeck
  if (!isImportDeck(job)) throw new Error('importer has no importDeck job')
  return { row, importDeck: job }
}

const queued = new Array<{ name: string; data: Record<string, unknown> }>()
const RecordingEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (name, data) =>
      Effect.sync(() => {
        queued.push({ name, data })
        return `job-${queued.length}`
      }),
  }),
)

describe('the importer importDeck job, on the live ports', () => {
  it('files the fixture PDF against the company as the integration, extracts it, and dedupes a hand upload', async () => {
    const company = await resolveEntity({
      kind: 'company',
      name: 'Acme Fusion',
      keys: { domain: 'acme-fusion.example' },
      source: { class: 'manual' },
    })
    const { row, importDeck } = await loadImporter()
    const logged = new Array<string>()

    const exit = await Effect.runPromiseExit(
      importDeck({
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(pdf))
            controller.close()
          },
        }),
        filename: FILENAME,
        mime: 'application/pdf',
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdentityLive(row),
            ContentLive(row),
            LogLive(row.capabilityId, {
              sink: (_level, line) => logged.push(line),
            }),
          ).pipe(Layer.provide(RecordingEnqueue)),
        ),
      ),
    )
    expect(exit._tag).toBe('Success')

    // One document, on the company the filename named, as the integration.
    const filed = await db
      .select({
        id: document.entityId,
        blobSha: document.blobSha,
        kind: document.kind,
        sourceClass: document.sourceClass,
        sourceRef: document.sourceRef,
        uploadedBy: document.uploadedBy,
      })
      .from(document)
      .innerJoin(link, eq(link.fromEntityId, document.entityId))
      .where(
        and(
          eq(link.toEntityId, company.entityId),
          eq(link.relation, 'tagged_in'),
        ),
      )
    expect(filed).toHaveLength(1)
    const doc = filed.at(0)
    if (!doc?.blobSha) throw new Error('no document')
    expect(doc).toMatchObject({
      kind: 'deck',
      sourceClass: 'integration',
      sourceRef: row.id,
      uploadedBy: null,
    })
    expect(await storage().exists(doc.blobSha)).toBe(true)
    const line = (
      await db
        .select({ actorId: activity.actorId, meta: activity.meta })
        .from(activity)
        .where(
          and(
            eq(activity.verb, 'document.filed'),
            eq(activity.objectEntityId, doc.id),
          ),
        )
    ).at(0)
    expect(line).toMatchObject({
      actorId: null,
      meta: { integrationId: row.id },
    })
    expect(queued).toEqual([
      { name: QUEUES.extractDocument, data: { documentId: doc.id } },
    ])
    expect(logged.join('\n')).toContain('[plugin:importer] filed')

    // The queued job, exactly as `runJob` would run it, minus the ledger.
    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          extractDocument.run({ documentId: doc.id }),
          JobContext,
          JobContext.of({
            queue: QUEUES.extractDocument,
            jobId: 'test-importer',
            attempt: 1,
            isFinalAttempt: true,
          }),
        ),
        ExtractionStore.layer,
      ),
    )
    const extracted = (
      await db
        .select({
          status: document.extractionStatus,
          text: document.extractedText,
        })
        .from(document)
        .where(eq(document.entityId, doc.id))
    ).at(0)
    expect(extracted?.status).toBe('done')
    expect(extracted?.text).toContain('Acme Fusion Series A deck')

    // The identical file uploaded by hand: prepare finds the bytes stored,
    // and finalize's birth dedupes to the plugin's row.
    const person = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!person) throw new Error('no fixture user')
    const prepared = await Effect.runPromise(
      prepareBlobUploadProgram({
        sha: doc.blobSha,
        sizeBytes: pdf.byteLength,
        preparedBy: person.id,
      }),
    )
    expect(prepared.alreadyStored).toBe(true)
    const hand = await Effect.runPromise(
      birthDocumentProgram({
        blobSha: doc.blobSha,
        filename: FILENAME,
        mime: 'application/pdf',
        sizeBytes: pdf.byteLength,
        kind: 'deck',
        sourceClass: 'manual',
        sourceRef: null,
        provenance: {},
        fileAgainst: [{ kind: 'record', entityId: company.entityId }],
        actor: { userId: person.id },
      }).pipe(Effect.provide(RecordingEnqueue)),
    )
    expect(hand).toEqual({ id: doc.id, deduped: true })
    expect(
      await db
        .select({ id: document.entityId })
        .from(document)
        .where(eq(document.blobSha, doc.blobSha)),
    ).toEqual([{ id: doc.id }])

    await storage().delete(doc.blobSha)
  })
})
