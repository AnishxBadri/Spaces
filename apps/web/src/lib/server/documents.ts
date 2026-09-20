import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { document, entity, jobRun, link } from '@spaces/db/schema'
import { DOCUMENT_KINDS, MAX_UPLOAD_BYTES } from '@spaces/core/documents'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '../queue'
import { storage } from '../storage'
import {
  deleteDocumentWithBlobGc,
  documentFilingEdges,
  documentFilingRefusal,
  documentProvenance,
  existingDocumentFiling,
  fileDocumentRow,
  requireUser,
} from './shared'

/**
 * Upload is two calls around a direct-to-storage PUT, because a 200MB deck
 * must not stream through Node (CONTEXT.md → Storage). The client hashes the
 * file, asks for a URL, PUTs the bytes, then files the row. The blob route
 * re-verifies the digest, so a lying client fails at the store, not here.
 */

const shaKey = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Blob keys are sha256 hex digests')

export const prepareDocumentUpload = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      sha: shaKey,
      sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const store = storage()
    // Content-addressed: the same deck sent to both partners is one blob.
    // Already stored ⇒ skip the transfer entirely.
    if (await store.exists(data.sha)) {
      const noUpload: { url: string | null; headers: Record<string, string> } =
        { url: null, headers: {} }
      return {
        uploadUrl: noUpload.url,
        uploadHeaders: noUpload.headers,
        alreadyStored: true,
      }
    }
    const { url, headers } = await store.getUploadUrl(data.sha, 600)
    return { uploadUrl: url, uploadHeaders: headers, alreadyStored: false }
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
       * Where this document is filed. A record files through
       * `link(tagged_in)`, a space through `entity_space` — the union is
       * what stops a space ever being a link target again (SPA-19).
       */
      fileAgainst: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('record'), entityId: z.string().uuid() }),
        z.object({ kind: z.literal('space'), entityId: z.string().uuid() }),
      ]),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()

    // The bytes must actually be in the store: a client that skipped the PUT
    // would otherwise leave a document row pointing at nothing.
    if (!(await storage().exists(data.sha))) {
      throw new Error('Upload incomplete — the file never reached storage')
    }

    const fileAgainst = data.fileAgainst
    const target = (
      await db
        .select({ kind: entity.kind, mergedIntoId: entity.mergedIntoId })
        .from(entity)
        .where(eq(entity.id, fileAgainst.entityId))
    ).at(0)
    if (!target) throw new Error('Record not found')
    if (target.mergedIntoId) throw new Error('That record has been merged away')
    // Refused here as well as in the writer, and before the dedupe read: a
    // mismatched target would otherwise dedupe against the wrong edge table
    // and answer `{ deduped: true }` for a filing that could never exist.
    const refusal = documentFilingRefusal(fileAgainst, target.kind)
    if (refusal) throw new Error(refusal)

    // Same file, same target, twice — one row, for both edge kinds. The
    // read is `existingDocumentFiling` in server/shared.ts, next to the
    // writer whose table choice it has to mirror.
    const existing = await existingDocumentFiling(data.sha, fileAgainst)
    if (existing) return { id: existing, deduped: true }

    // The rows themselves are `fileDocumentRow` in server/shared.ts: this
    // file is re-exported to the client by the server-fns barrel (CLAUDE.md
    // → Traps), so the half a test can call has to live next door. What
    // stays here is what needs a request — the auth check, the storage
    // probe, the dedupe read and the enqueue.
    const { id } = await fileDocumentRow({
      sha: data.sha,
      filename: data.filename,
      mime: data.mime ?? null,
      sizeBytes: data.sizeBytes,
      kind: data.kind,
      fileAgainst,
      actorId: u.id,
    })

    // Outside the transaction: a queue that's down must not roll back a
    // perfectly good upload. The row stays 'pending' and can be re-queued.
    await enqueue(QUEUES.extractDocument, { documentId: id })

    return { id, deduped: false }
  })

/** Documents filed against a record — the Files tab. */
export const listRecordDocuments = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const rows = await db
      .select({
        id: document.entityId,
        filename: document.filename,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        kind: document.kind,
        extractionStatus: document.extractionStatus,
        extractionError: document.extractionError,
        createdAt: document.createdAt,
        uploadedBy: document.uploadedBy,
        // Enough text to prove extraction worked, without hauling a
        // 2MB column into every Files-tab render.
        snippet: sql<string | null>`left(${document.extractedText}, 200)`,
      })
      .from(link)
      .innerJoin(document, eq(document.entityId, link.fromEntityId))
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(
          eq(link.toEntityId, data.entityId),
          eq(link.relation, 'tagged_in'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(desc(document.createdAt))

    if (rows.length === 0) return []
    const users = await db.select({ id: user.id, name: user.name }).from(user)
    const names = new Map(users.map((x) => [x.id, x.name]))

    // Who filed it (SPA-137). The class alone is only half an answer for one
    // of the eight values — "integration" names no integration — so the ref
    // is resolved to the capability id here, server side, once, exactly as
    // the dedupe card resolves an entity's. The row said `origin` until this
    // slice and nothing rendered it; now the class is a class and the vendor
    // is a row, and the file line can finally name it.
    const provenance = await documentProvenance(rows.map((r) => r.id))

    // Every edge each document is filed by, not just this record's (SPA-50).
    // The filing control renders both kinds as chips, and a per-row fetch
    // would open one request per file to draw a popover nobody has clicked.
    const filings = await documentFilingEdges(rows.map((r) => r.id))

    // The last extraction attempt per document (SPA-106). `document.extraction_*`
    // says what the file is; `job_run` says what the worker did about it — which
    // attempt, how long it took, how long ago — and until this join the second
    // half was invisible to everyone but an operator with a psql prompt.
    // `distinct on` sorted by started_at desc is the last row per entity, which
    // is exactly the shape the index on (entity_id, started_at) serves.
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

    return rows.map((r) => {
      // Not `?? 'manual'`: a default here would invent a provenance for a
      // row whose own is missing, which is the lie the whole collapse is
      // against. The id came out of `document` two statements ago, so a miss
      // is a bug, and it says so.
      const source = provenance.get(r.id)
      if (!source) throw new Error(`No provenance row for document ${r.id}`)
      return {
        ...r,
        filename: r.filename ?? 'Untitled file',
        createdAt: r.createdAt.toISOString(),
        uploadedByName: r.uploadedBy ? (names.get(r.uploadedBy) ?? null) : null,
        snippet: r.snippet?.replace(/\s+/g, ' ').trim() || null,
        lastRun: runs.get(r.id) ?? null,
        sourceClass: source.sourceClass,
        sourceCapability: source.sourceCapability,
        filedIn: filings.get(r.id) ?? [],
      }
    })
  })

/**
 * Full extracted text for one document, fetched only when a preview opens.
 * The list deliberately carries a 200-char snippet instead — this column runs
 * to 2MB and nothing wants it in every Files-tab render.
 */
export const getDocumentText = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    // `.at(0)` rather than destructuring: the row genuinely may not exist, and
    // a destructured element types as always-present here.
    const row = (
      await db
        .select({ text: document.extractedText })
        .from(document)
        .where(eq(document.entityId, data.id))
    ).at(0)
    return { text: row?.text ?? null }
  })

export const getDocumentDownloadUrl = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const row = (
      await db
        .select({ blobSha: document.blobSha, filename: document.filename })
        .from(document)
        .where(eq(document.entityId, data.id))
    ).at(0)
    if (!row?.blobSha) throw new Error('This document has no stored file')
    return {
      url: await storage().getDownloadUrl(
        row.blobSha,
        300,
        row.filename === null ? {} : { filename: row.filename },
      ),
    }
  })

/**
 * Real delete, not an archive flag: a misfiled upload the operator can't
 * remove is worse than the audit trail it costs. The blob only goes when no
 * other document row shares its digest — content-addressing means one file
 * can back several rows.
 *
 * What dies with the entity is the registry's answer, not this file's: the
 * hand-list that used to live here cleared chunks, links, activity and the
 * two rows, and missed `entity_space`, `task_entity`, `interaction_entity`
 * and `duplicate_candidate` — a document tagged into a space could not be
 * deleted at all. Now that a document files into a space on purpose (SPA-19)
 * that registry entry is load-bearing rather than incidental, which is what
 * `documents-filing.test.ts` pins.
 *
 * The rows and the blob GC are `deleteDocumentWithBlobGc` in
 * `server/shared.ts`, for the reason `fileDocumentRow` lives there: a test
 * has no request, and this handler is the auth check and nothing else.
 */
export const deleteDocument = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    return deleteDocumentWithBlobGc(data.id)
  })

/**
 * Re-file, change kind, re-extract — §3.3's three actions on a filed
 * document (SPA-50). Each is `requireUser()` plus `effectFn(program)` and
 * nothing else; the programs are `#/lib/documents/refile`, outside
 * `lib/server/` so a test can drive them without a request.
 *
 * The typed refusals are turned into sentences here rather than allowed to
 * reject as they are: `Effect.runPromise` rejects with the tagged error
 * itself, and a `Schema.TaggedError` carries no `message`, so "merged away"
 * would otherwise reach the chip row empty (the rule `voidLedgerEvent` set).
 */
const filingTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('record'), entityId: z.string().uuid() }),
  z.object({ kind: z.literal('space'), entityId: z.string().uuid() }),
])

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
 * `z.enum(DOCUMENT_KINDS)` is where a kind outside the list dies — the
 * validator, not the program, for the reason every other enum the client can
 * name is narrowed there: the boundary is the one place the untrusted string
 * exists.
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
