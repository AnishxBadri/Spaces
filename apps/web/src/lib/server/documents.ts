import { excerpt } from '@spaces/core/context/excerpt'
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { document, entity, jobRun, link } from '@spaces/db/schema'
import { DOCUMENT_KINDS, MAX_UPLOAD_BYTES } from '@spaces/core/documents'
import { QUEUES } from '@spaces/core/queue/names'
import { storage } from '@spaces/core/writes/storage'
import {
  deleteDocumentWithBlobGc,
  documentFilingEdges,
  documentProvenance,
  requireUser,
} from './shared'
import type { DocumentBirthInput } from '@spaces/core/writes/documents/birth'

/**
 * Upload is two calls around a direct-to-storage PUT, because a 200MB deck
 * must not stream through Node. The client hashes the file, asks for a URL,
 * PUTs the bytes, then files the row. The blob route re-verifies the digest,
 * so a lying client fails at the store, not here.
 */

const shaKey = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Blob keys are sha256 hex digests')

/**
 * Where a document is filed. A record files through `link(tagged_in)`, a
 * space through `entity_space`; the union stops a space ever being a link
 * target. One validator, shared by upload and re-file, so the two cannot drift.
 */
const filingTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('record'), entityId: z.string().uuid() }),
  z.object({ kind: z.literal('space'), entityId: z.string().uuid() }),
])

export const prepareDocumentUpload = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      sha: shaKey,
      sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    // `prepareBlobUploadProgram` decides "already stored" and writes the
    // `pending_blob` row the orphan sweep reads. Dynamic import so Effect and
    // drizzle stay out of the client bundle.
    const { prepareBlobUploadProgram, prepareBlobUploadMessage } =
      await import('@spaces/core/writes/documents/prepare')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(prepareBlobUploadProgram)({
        sha: data.sha,
        sizeBytes: data.sizeBytes,
        preparedBy: u.id,
      })
    } catch (failure) {
      throw new Error(prepareBlobUploadMessage(failure))
    }
  })

export const finalizeDocumentUpload = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      sha: shaKey,
      filename: z.string().trim().min(1).max(400),
      mime: z.string().max(200).nullish(),
      sizeBytes: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
      kind: z.enum(DOCUMENT_KINDS).default('other'),
      /**
       * Where this document is filed. `.min(0)` is deliberate: zero targets
       * is an unfiled document (the inbox), N is one row filed in N places.
       */
      fileAgainst: z.array(filingTarget).min(0),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()

    // The bytes must actually be in the store: a client that skipped the PUT
    // would otherwise leave a document row pointing at nothing.
    if (!(await storage().exists(data.sha))) {
      throw new Error('Upload incomplete — the file never reached storage')
    }

    // `birthDocumentProgram` is the one document write path. Dynamic import:
    // this file is re-exported to the browser by the server-fns barrel and
    // only handler bodies are stripped, so Effect and drizzle must not be
    // top-level imports. Its extraction enqueue is provided by `webEnqueue`.
    const { birthDocumentProgram, documentBirthMessage } =
      await import('@spaces/core/writes/documents/birth')
    const { webEnqueue } = await import('../enqueue-live')
    const { Effect } = await import('effect')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn((input: DocumentBirthInput) =>
        birthDocumentProgram(input).pipe(Effect.provide(webEnqueue)),
      )({
        blobSha: data.sha,
        filename: data.filename,
        mime: data.mime ?? null,
        sizeBytes: data.sizeBytes,
        kind: data.kind,
        // A person dropped a file on a surface we ship: the plainest `manual`
        // write, and the class/ref biconditional would refuse a ref anyway.
        sourceClass: 'manual',
        sourceRef: null,
        // Nothing to say: no provider tree, no provider id, no connection.
        provenance: {},
        fileAgainst: data.fileAgainst,
        actor: { userId: u.id },
      })
    } catch (failure) {
      throw new Error(documentBirthMessage(failure))
    }
  })

/**
 * Save a link: the one arrival with no bytes, so no hash, prepare, PUT or
 * storage probe.
 * - Returns before any network call: `clipUrlProgram` checks the URL against
 *   the SSRF table, births the row `pending` and enqueues `document.clip`.
 * - `fileAgainst` uses the upload's `filingTarget`: it is the same filing.
 * - Dynamic import, for the same client-bundle reason as the upload.
 */
export const clipUrl = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      url: z.string().url(),
      fileAgainst: z.array(filingTarget).min(0),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { clipUrlProgram, clipUrlMessage } = await import('../documents/clip')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(clipUrlProgram)({
        url: data.url,
        fileAgainst: data.fileAgainst,
        actor: { userId: u.id },
      })
    } catch (failure) {
      throw new Error(clipUrlMessage(failure))
    }
  })

/** Documents filed against a record — the Files tab. */
export const listRecordDocuments = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { recordDocumentRows } = await import('../documents/record-files')
    const rows = await recordDocumentRows(u.id, data.entityId)

    if (rows.length === 0) return []
    // A readable attaching email names the file: `via <subject>`.
    const { attachmentEmailsProgram } =
      await import('../documents/attachment-emails')
    const { effectFn } = await import('./effect')
    const attached = await effectFn(attachmentEmailsProgram)(
      u,
      rows.map((r) => r.id),
    )
    const users = await db.select({ id: user.id, name: user.name }).from(user)
    const names = new Map(users.map((x) => [x.id, x.name]))

    // Who filed it. "integration" names no integration, so the ref is
    // resolved to the capability id here, server side, once.
    const provenance = await documentProvenance(rows.map((r) => r.id))

    // Every edge each document is filed by, not just this record's. The
    // filing control renders both kinds as chips, and a per-row fetch would
    // open one request per file to draw a popover nobody has clicked.
    const filings = await documentFilingEdges(rows.map((r) => r.id))

    // The last extraction attempt per document: `job_run` says what the
    // worker did (attempt, duration, how long ago). `distinct on` sorted by
    // started_at desc is the last row per entity, the shape the
    // (entity_id, started_at) index serves.
    const lastRuns = await db
      .selectDistinctOn([jobRun.entityId], {
        entityId: jobRun.entityId,
        status: jobRun.status,
        attempt: jobRun.attempt,
        durationMs: jobRun.durationMs,
        startedAt: jobRun.startedAt,
        finishedAt: jobRun.finishedAt,
      })
      .from(jobRun)
      .where(
        and(
          eq(jobRun.queue, QUEUES.extractDocument),
          inArray(
            jobRun.entityId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(jobRun.entityId, desc(jobRun.startedAt))

    // `sinceMs` is computed here rather than in the component on purpose: a
    // relative time read off the browser's clock renders one string on the
    // server and another during hydration, which is a mismatch.
    const now = Date.now()
    const runs = new Map(
      lastRuns.map((r) => [
        r.entityId,
        {
          status: r.status,
          attempt: r.attempt,
          durationMs: r.durationMs,
          sinceMs: now - (r.finishedAt ?? r.startedAt).getTime(),
        },
      ]),
    )

    // The newest document that supersedes each row: the older row reads
    // "Replaced by → <name>", dimmed. Nothing else changes about it.
    const replacements = await db
      .selectDistinctOn([link.toEntityId], {
        olderId: link.toEntityId,
        id: document.entityId,
        name: document.filename,
      })
      .from(link)
      .innerJoin(document, eq(document.entityId, link.fromEntityId))
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(
          eq(link.relation, 'supersedes'),
          inArray(
            link.toEntityId,
            rows.map((r) => r.id),
          ),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(link.toEntityId, desc(link.createdAt))
    const replacedBy = new Map(
      replacements.map((r) => [
        r.olderId,
        { id: r.id, name: r.name ?? 'Untitled file' },
      ]),
    )

    // Follow takes a record that holds a binding: a person's tab offers none.
    const { followableRecord } = await import('../documents/follow')
    const recordFollows = await followableRecord(data.entityId)

    return rows.map((row) => {
      // Never default to `'manual'`: that would invent a provenance. The id
      // came out of `document` above, so a miss is a bug, and it says so.
      const source = provenance.get(row.id)
      if (!source) throw new Error(`No provenance row for document ${row.id}`)
      const {
        followable,
        followStatus,
        followSyncedAt,
        priorRevisions,
        revisedAt,
        ...r
      } = row
      return {
        ...r,
        /** A followed file's binding; null for a file never followed. */
        follow:
          followStatus === null
            ? null
            : {
                status: followStatus,
                lastSyncedAt:
                  followSyncedAt === null ? null : followSyncedAt.toISOString(),
                revisions: priorRevisions + 1,
                revisedAt:
                  revisedAt === null ? null : new Date(revisedAt).toISOString(),
              },
        /**
         * Whether the row's `···` offers Follow: a file a connection brought
         * and no folder binding holds, not gone, not followed right now.
         */
        canFollow:
          recordFollows &&
          followable &&
          r.externalStatus !== 'gone' &&
          (r.bindingId === null || followStatus === 'paused'),
        filename: r.filename ?? 'Untitled file',
        createdAt: r.createdAt.toISOString(),
        uploadedByName: r.uploadedBy ? (names.get(r.uploadedBy) ?? null) : null,
        snippet: excerpt(r.snippet ?? '') || null,
        lastRun: runs.get(r.id) ?? null,
        sourceClass: source.sourceClass,
        sourceCapability: source.sourceCapability,
        filedIn: filings.get(r.id) ?? [],
        replacedBy: replacedBy.get(r.id) ?? null,
        /** The readable email it came attached to: `via <subject>`. */
        email: attached.get(r.id) ?? null,
      }
    })
  })

/**
 * Every document in the workspace, one row each: the `/files` shelf. The
 * query is `listDocumentsProgram`, kept out of the server-fn modules so a test
 * can drive it without a request.
 * - `filed: 'unfiled'` is the inbox (arrivals with no filing edge), a filter
 *   on this list rather than a route of its own.
 * - Defaults to `'all'`, matching the route's `validateSearch`.
 */
export const listDocuments = createServerFn()
  .validator(
    z
      .object({ filed: z.enum(['all', 'unfiled']).default('all') })
      .default({ filed: 'all' }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { listDocumentsProgram } = await import('../documents/shelf')
    const { effectFn } = await import('./effect')
    return effectFn(listDocumentsProgram)({ filed: data.filed, viewer: u })
  })

/**
 * How many documents are unfiled, for Today's readout strip. Its own server
 * fn so no other domain's reader answers for documents. Uses
 * `unfiledPredicate()`, the same fragment `listDocuments({ filed: 'unfiled' })`
 * filters with, so the badge and the list cannot disagree.
 */
export const countUnfiledDocuments = createServerFn().handler(async () => {
  const u = await requireUser()
  const { countUnfiledProgram } = await import('../documents/shelf')
  const { effectFn } = await import('./effect')
  return effectFn(countUnfiledProgram)(u)
})

/**
 * Not a document private to someone else: the by-id reads' gate. A dynamic
 * import, so drizzle stays out of the client bundle.
 */
async function readable(userId: string) {
  const { canReadDocumentSql } =
    await import('@spaces/core/writes/read/can-read-sql')
  return canReadDocumentSql(userId)
}

/**
 * Full extracted text for one document, fetched only when a preview opens.
 * The list deliberately carries a 200-char snippet instead — this column runs
 * to 2MB and nothing wants it in every Files-tab render.
 */
export const getDocumentText = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    // `.at(0)` rather than destructuring: the row genuinely may not exist, and
    // a destructured element types as always-present here.
    const row = (
      await db
        .select({ text: document.extractedText })
        .from(document)
        .where(and(eq(document.entityId, data.id), await readable(u.id)))
    ).at(0)
    return { text: row?.text ?? null }
  })

/**
 * A short-lived URL for the bytes.
 *
 * A clip keeps no bytes, so asking for one throws. Keep the throw: no control
 * reaches it (every surface reads `blobSha` and offers "Open source"), and a
 * null answer would turn a wrong call into a silent one.
 */
export const getDocumentDownloadUrl = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    // A `remote` row (retain: text) is fetched from its provider first; the
    // throw says so, and the viewer's Download polls `getDocumentBytes`.
    const { documentBytesProgram } = await import('../documents/remote-bytes')
    const { effectFn } = await import('./effect')
    const bytes = await effectFn(documentBytesProgram)(u.id, data.id, {
      poll: false,
    })
    if (bytes.state === 'ready') return { url: bytes.url }
    throw new Error(
      bytes.state === 'fetching'
        ? `Fetching this file from ${bytes.from}; try again in a moment`
        : bytes.reason,
    )
  })

/**
 * Real delete, not an archive flag: a misfiled upload the operator can't
 * remove is worse than the audit trail it costs.
 * - The blob goes only when no other document row shares its digest.
 * - What dies with the entity is the `ENTITY_REFS` registry's answer; never
 *   hand-list tables here (a hand list missed `entity_space`).
 * - The work is `deleteDocumentWithBlobGc`; this handler is the auth check.
 */
export const deleteDocument = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    return deleteDocumentWithBlobGc(data.id)
  })

/**
 * Re-file, change kind, re-extract: the actions on a filed document. Each is
 * `requireUser()` plus `effectFn(program)`; the programs live outside the
 * server-fn modules so a test can drive them without a request.
 *
 * Typed refusals are turned into sentences here: a `Schema.TaggedError`
 * carries no `message`, so "merged away" would otherwise reach the UI empty.
 */

export const fileDocument = createServerFn({ method: 'POST' })
  .validator(z.object({ documentId: z.string().uuid(), target: filingTarget }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { fileDocumentProgram, documentRefileMessage } =
      await import('../documents/refile')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(fileDocumentProgram)(u.id, data)
    } catch (failure) {
      throw new Error(documentRefileMessage(failure))
    }
  })

export const unfileDocument = createServerFn({ method: 'POST' })
  .validator(z.object({ documentId: z.string().uuid(), target: filingTarget }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { unfileDocumentProgram, documentRefileMessage } =
      await import('../documents/refile')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(unfileDocumentProgram)(u.id, data)
    } catch (failure) {
      throw new Error(documentRefileMessage(failure))
    }
  })

/**
 * A kind outside `DOCUMENT_KINDS` dies in the validator, not the program: the
 * boundary is the one place the untrusted string exists.
 */
export const setDocumentKind = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      documentId: z.string().uuid(),
      kind: z.enum(DOCUMENT_KINDS),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { setDocumentKindProgram, documentRefileMessage } =
      await import('../documents/refile')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(setDocumentKindProgram)(u.id, data)
    } catch (failure) {
      throw new Error(documentRefileMessage(failure))
    }
  })

export const reExtractDocument = createServerFn({ method: 'POST' })
  .validator(z.object({ documentId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { reExtractDocumentProgram, documentRefileMessage } =
      await import('../documents/refile')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(reExtractDocumentProgram)(u.id, data.documentId)
    } catch (failure) {
      throw new Error(documentRefileMessage(failure))
    }
  })
