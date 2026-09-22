import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { document, entity, jobRun, link } from '@spaces/db/schema'
import { DOCUMENT_KINDS, MAX_UPLOAD_BYTES } from '@spaces/core/documents'
import { QUEUES } from '@spaces/core/queue/names'
import { storage } from '../storage'
import {
  deleteDocumentWithBlobGc,
  documentFilingEdges,
  documentProvenance,
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

/**
 * Where a document is filed. A record files through `link(tagged_in)`, a
 * space through `entity_space` — the union is what stops a space ever being a
 * link target again (SPA-19). One validator, shared by the upload and by
 * §3.3's re-file, so the two cannot drift.
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
    // The decision — already stored, and whether to write the `pending_blob`
    // row the orphan sweep reads (SPA-54) — is `prepareBlobUploadProgram` in
    // `#/lib/documents/prepare`, reached by a **dynamic** import inside the
    // handler so Effect and drizzle stay out of the client bundle, exactly as
    // `finalizeDocumentUpload` below reaches birth.
    const { prepareBlobUploadProgram, prepareBlobUploadMessage } =
      await import('../documents/prepare')
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
       * Where this document is filed — **an array** since SPA-113, and
       * `.min(0)` says so deliberately: zero targets is an unfiled document
       * (§11.6's inbox), one is a record or a space, N is one row filed in N
       * places (§3.4). The browser lane passes one element today.
       */
      fileAgainst: z.array(filingTarget).min(0),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()

    // The bytes must actually be in the store: a client that skipped the PUT
    // would otherwise leave a document row pointing at nothing. This is the
    // browser lane's own guard — the bytes were PUT before this call — and
    // the only thing left here that needs a request.
    if (!(await storage().exists(data.sha))) {
      throw new Error('Upload incomplete — the file never reached storage')
    }

    // The write itself is `birthDocumentProgram` (§3.1's one server path),
    // reached by a **dynamic** import inside the handler so Effect and
    // drizzle stay out of the client bundle: this file is re-exported to the
    // browser by the server-fns barrel and only handler bodies are stripped
    // (CLAUDE.md → Traps). `lib/server/objects.ts` reaches `effectFn` the
    // same way, and `lib/documents/birth.ts` is never in the barrel.
    const { birthDocumentProgram, documentBirthMessage } =
      await import('../documents/birth')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(birthDocumentProgram)({
        blobSha: data.sha,
        filename: data.filename,
        mime: data.mime ?? null,
        sizeBytes: data.sizeBytes,
        kind: data.kind,
        // A person dropped a file on a surface we ship, which is the
        // plainest `manual` write in the product (D1) — and the
        // biconditional would refuse a ref anyway.
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
 * **Save a link** — §3.1 entry point 5, the one arrival with no bytes
 * (SPA-117). It is not an upload and shares none of the upload's machinery:
 * no hash, no prepare, no PUT, no storage probe. A URL, a place to file it,
 * and a row.
 *
 * It **returns before any network call**: `clipUrlProgram` validates the URL
 * against the SSRF table, births the row `pending` and enqueues
 * `document.clip`. The fetch happens on the worker, so a page that takes
 * thirty seconds is thirty seconds of a job rather than of this request — and
 * with the worker down the row simply stays pending.
 *
 * `fileAgainst` is the **same array** and the same `filingTarget` validator
 * the upload uses, because a link filed against a record and a deck filed
 * against a record are the same filing (§3.4). The writer is
 * `lib/documents/clip.ts`, reached by a dynamic import inside the handler for
 * the reason `finalizeDocumentUpload` reaches birth that way: this file is
 * re-exported to the browser by the server-fns barrel and only handler bodies
 * are stripped (CLAUDE.md → Traps).
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
        // Whether there are bytes at all (docsurf-10b). Null on a clipped
        // article — the page was read, never stored — and the row's controls
        // read it: a download that cannot exist is offered as "Open source"
        // instead, rather than as a button that throws when pressed.
        blobSha: document.blobSha,
        // The clip's own address (SPA-117), and the one column that tells a
        // saved article from a file: the row's pending state reads
        // "fetching…" rather than "extracting text…" when it is set.
        url: document.url,
        // The storage-source half of the row (SPA-78,
        // `docs/spec-storage-sources.md` §8): where the provider's copy can
        // be opened, and whether it is still there. Both null on every
        // document until a storage-source plugin files one, and the row
        // renders nothing extra when they are.
        externalUrl: document.externalUrl,
        externalStatus: document.externalStatus,
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
 * Every document in the workspace, one row each — the `/documents` shelf
 * (SPA-58). `requireUser()` plus `effectFn(program)` and nothing else; the
 * query is `#/lib/documents/shelf`, outside `lib/server/` so a test can drive
 * it without a request and so it never reaches the client barrel.
 *
 * One argument since SPA-124: `filed`. `'unfiled'` is the inbox — arrivals
 * carrying no filing edge (`docs/spec-storage-sources.md` §3.2) — and it is a
 * filter on this list rather than a route of its own, which is what makes
 * `/documents?filed=unfiled` the whole feature. It defaults to `'all'`, so
 * the route's `validateSearch` and this validator agree on the same default
 * and a call with no `data` still reads the shelf. Saved views are
 * docsurf-12a.
 */
export const listDocuments = createServerFn()
  .validator(
    z
      .object({ filed: z.enum(['all', 'unfiled']).default('all') })
      .default({ filed: 'all' }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { listDocumentsProgram } = await import('../documents/shelf')
    const { effectFn } = await import('./effect')
    return effectFn(listDocumentsProgram)({ filed: data.filed })
  })

/**
 * How many documents are unfiled — one number for Today's readout strip
 * (SPA-124, `docs/spec-storage-sources.md` §11 delta 6).
 *
 * Its own server fn rather than a field on some existing loader's answer,
 * for the reason `countOpenInbox` is its own: Today reads six counters from
 * five domains in one `Promise.all`, and a documents count wedged into the
 * inbox's shape would make one domain's reader answer for another's. The
 * predicate behind it is `unfiledPredicate()`, the same fragment
 * `listDocuments({ filed: 'unfiled' })` filters with, so the badge and the
 * list it links to cannot disagree.
 */
export const countUnfiledDocuments = createServerFn().handler(async () => {
  await requireUser()
  const { countUnfiledProgram } = await import('../documents/shelf')
  const { effectFn } = await import('./effect')
  return effectFn(countUnfiledProgram)()
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

/**
 * A short-lived URL for the bytes.
 *
 * **The `blob_sha IS NULL` throw stays** (docsurf-10b). A clip keeps no
 * bytes by design (§3.1), so "this document has no stored file" is the
 * literal truth about the row and the right answer to an id that names one —
 * an SDK caller, a stale tab, a hand-made request. What changed is that no
 * control can reach it any more: the Files tab, the space Sources lane,
 * `/documents` and `DocumentPreview` all read `blobSha` and render "Open
 * source" against `document.url` where there is nothing to download. Softening
 * this into a null answer would have turned a wrong call into a silent one.
 */
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
 * `server/shared.ts`, for the reason birth lives outside this file: a test
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
 *
 * `filingTarget` is declared above, beside the upload that also validates it.
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
