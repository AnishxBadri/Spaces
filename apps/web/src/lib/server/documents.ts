import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { DOCUMENT_KINDS, MAX_UPLOAD_BYTES } from '@spaces/core/documents'
import { storage } from '@spaces/core/writes/storage'
import { requireUser } from './shared'
import type { DocumentBirthInput } from '@spaces/core/writes/documents/birth'
import { input } from './input'
import { serverQuery } from './query'

/**
 * Upload is two calls around a direct-to-storage PUT, because a 200MB deck
 * must not stream through Node. The client hashes the file, asks for a URL,
 * PUTs the bytes, then files the row. The blob route re-verifies the digest,
 * so a lying client fails at the store, not here.
 */

const shaKey = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/, {
    message: 'Blob keys are sha256 hex digests',
  }),
)

const uuid = Schema.String.check(Schema.isUUID())

/** A document the caller asked for cannot be had, with the reason the UI shows. */
class DocumentUnavailable extends Schema.TaggedError<DocumentUnavailable>()(
  'DocumentUnavailable',
  { message: Schema.String },
) {}

/**
 * Where a document is filed. A record files through `link(tagged_in)`, a
 * space through `entity_space`; the union stops a space ever being a link
 * target. One validator, shared by upload and re-file, so the two cannot drift.
 */
const filingTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('record'), entityId: uuid }),
  Schema.Struct({ kind: Schema.Literal('space'), entityId: uuid }),
])

/**
 * Where an arrival is filed. Empty is deliberate: zero targets is an unfiled
 * document (the inbox), N is one row filed in N places.
 */
const filingTargets = Schema.mutable(Schema.Array(filingTarget))

export const prepareDocumentUpload = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        sha: shaKey,
        sizeBytes: Schema.Int.check(
          Schema.isGreaterThan(0),
          Schema.isLessThanOrEqualTo(MAX_UPLOAD_BYTES),
        ),
      }),
    ),
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

/**
 * The bytes must actually be in the store: a client that skipped the PUT
 * would otherwise leave a document row pointing at nothing.
 */
const uploadReachedStorageProgram = Effect.fn('uploadReachedStorageProgram')(
  function* (sha: string) {
    const stored = yield* Effect.promise(() => storage().exists(sha))
    if (!stored)
      return yield* new DocumentUnavailable({
        message: 'Upload incomplete — the file never reached storage',
      })
  },
)

export const finalizeDocumentUpload = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        sha: shaKey,
        filename: Schema.Trim.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(400),
        ),
        mime: Schema.optional(
          Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
        ),
        sizeBytes: Schema.Int.check(
          Schema.isGreaterThanOrEqualTo(0),
          Schema.isLessThanOrEqualTo(MAX_UPLOAD_BYTES),
        ),
        kind: Schema.Literals(DOCUMENT_KINDS).pipe(
          Schema.withDecodingDefault(Effect.succeed('other' as const)),
        ),
        fileAgainst: filingTargets,
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    await Effect.runPromise(uploadReachedStorageProgram(data.sha))

    // `birthDocumentProgram` is the one document write path. Dynamic import:
    // this file is re-exported to the browser by the server-fns barrel and
    // only handler bodies are stripped, so the write path must not be a
    // top-level import. Its extraction enqueue is provided by `webEnqueue`.
    const { birthDocumentProgram, documentBirthMessage } =
      await import('@spaces/core/writes/documents/birth')
    const { webEnqueue } = await import('../enqueue-live')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn((birth: DocumentBirthInput) =>
        birthDocumentProgram(birth).pipe(Effect.provide(webEnqueue)),
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
    input(
      Schema.Struct({
        url: Schema.String.check(
          // Whatever `new URL` parses once trimmed; the value passes as sent.
          Schema.makeFilter((s: string) => URL.canParse(s.trim()), {
            expected: 'a URL',
          }),
        ),
        fileAgainst: filingTargets,
      }),
    ),
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

const listRecordDocumentsProgram = Effect.fn('listRecordDocumentsProgram')(
  function* (userId: string, entityId: string) {
    const { recordDocumentRows, describeDocumentRowsProgram } =
      yield* Effect.promise(() => import('../documents/record-files'))
    const rows = yield* Effect.promise(() =>
      recordDocumentRows(userId, entityId),
    )
    if (rows.length === 0) return []
    // Follow takes a record that holds a binding: a person's tab offers none.
    const { followableRecord } = yield* Effect.promise(
      () => import('../documents/follow'),
    )
    const recordFollows = yield* Effect.promise(() =>
      followableRecord(entityId),
    )
    return yield* describeDocumentRowsProgram(userId, rows, recordFollows)
  },
)

/** Documents filed against a record — the Files tab. */
export const listRecordDocuments = createServerFn()
  .validator(input(Schema.Struct({ entityId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(listRecordDocumentsProgram(u.id, data.entityId))
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
    input(
      Schema.Struct({
        filed: Schema.Literals(['all', 'unfiled']).pipe(
          Schema.withDecodingDefault(Effect.succeed('all' as const)),
        ),
      }).pipe(
        Schema.withDecodingDefault(Effect.succeed({ filed: 'all' as const })),
      ),
    ),
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

/** The shelf's `All n · Unfiled n` tab counts, whichever tab is open. */
export const countShelfDocuments = createServerFn().handler(async () => {
  const u = await requireUser()
  const { shelfCountsProgram } = await import('../documents/shelf')
  const { effectFn } = await import('./effect')
  return effectFn(shelfCountsProgram)(u)
})

/** Not a document private to someone else: the by-id reads' gate. */
const readableProgram = Effect.fn('readableProgram')(function* (
  userId: string,
) {
  // A dynamic import, so drizzle stays out of the client bundle.
  const { canReadDocumentSql } = yield* Effect.promise(
    () => import('@spaces/core/writes/read/can-read-sql'),
  )
  return canReadDocumentSql(userId)
})

const getDocumentTextProgram = Effect.fn('getDocumentTextProgram')(function* (
  userId: string,
  id: string,
) {
  const readable = yield* readableProgram(userId)
  // `.at(0)` rather than destructuring: the row genuinely may not exist, and
  // a destructured element types as always-present here.
  const row = (yield* serverQuery(() =>
    db
      .select({ text: document.extractedText })
      .from(document)
      .where(and(eq(document.entityId, id), readable)),
  )).at(0)
  return { text: row?.text ?? null }
})

/**
 * Full extracted text for one document, fetched only when a preview opens.
 * The list deliberately carries a 200-char snippet instead — this column runs
 * to 2MB and nothing wants it in every Files-tab render.
 */
export const getDocumentText = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(getDocumentTextProgram(u.id, data.id))
  })

const getDocumentDownloadUrlProgram = Effect.fn(
  'getDocumentDownloadUrlProgram',
)(function* (userId: string, id: string) {
  // A `remote` row (retain: text) is fetched from its provider first; the
  // refusal says so, and the viewer's Download polls `getDocumentBytes`.
  const { documentBytesProgram } = yield* Effect.promise(
    () => import('../documents/remote-bytes'),
  )
  const bytes = yield* documentBytesProgram(userId, id, { poll: false })
  if (bytes.state === 'ready') return { url: bytes.url }
  return yield* new DocumentUnavailable({
    message:
      bytes.state === 'fetching'
        ? `Fetching this file from ${bytes.from}; try again in a moment`
        : bytes.reason,
  })
})

/**
 * A short-lived URL for the bytes.
 *
 * A clip keeps no bytes, so asking for one refuses. Keep the refusal: no
 * control reaches it (every surface reads `blobSha` and offers "Open
 * source"), and a null answer would turn a wrong call into a silent one.
 */
export const getDocumentDownloadUrl = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(getDocumentDownloadUrlProgram(u.id, data.id))
  })

/**
 * `Delete…`: a real delete, not an archive flag, and only of a file the
 * caller can read. The work and the History lines are
 * `deleteDocumentProgram`; this handler is the session check, and turns its
 * refusals into sentences.
 */
export const deleteDocument = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { deleteDocumentProgram, deleteDocumentMessage } =
      await import('../documents/delete')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(deleteDocumentProgram)(u.id, data.id)
    } catch (failure) {
      throw new Error(deleteDocumentMessage(failure))
    }
  })

/**
 * Re-file, change kind, re-extract: the actions on a filed document. Each is
 * `requireUser()` plus `effectFn(program)`; the programs live outside the
 * server-fn modules so a test can drive them without a request.
 *
 * Typed refusals are turned into sentences here: a `Schema.TaggedError`
 * carries no `message`, so "merged away" would otherwise reach the UI empty.
 */

/**
 * File on… by hand. An email attachment whose file is still in the mailbox
 * is kept here too, through `fileByHandProgram`.
 */
export const fileDocument = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ documentId: uuid, target: filingTarget })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { documentRefileMessage } = await import('../documents/refile')
    const { fileByHandProgram } = await import('../documents/keep-copy')
    const { MailAttachments } = await import('../arrival/mail-attachments')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn((userId: string, filing: typeof data) =>
        fileByHandProgram(userId, filing).pipe(
          Effect.provide(MailAttachments.layer),
        ),
      )(u.id, data)
    } catch (failure) {
      throw new Error(documentRefileMessage(failure))
    }
  })

/**
 * Keep a copy: an email attachment's file fetched from its mailbox and
 * stored here. The work is `keepCopyProgram`.
 */
export const keepDocumentCopy = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ documentId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { keepCopyProgram, keepCopyMessage } =
      await import('../documents/keep-copy')
    const { MailAttachments } = await import('../arrival/mail-attachments')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn((userId: string, documentId: string) =>
        keepCopyProgram(userId, documentId).pipe(
          Effect.provide(MailAttachments.layer),
        ),
      )(u.id, data.documentId)
    } catch (failure) {
      throw new Error(keepCopyMessage(failure))
    }
  })

export const unfileDocument = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ documentId: uuid, target: filingTarget })))
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
 * The `File under…` popover's read: what the file is filed under, and the
 * bands to offer (`Named in the file` and `Recent` with nothing typed, kind
 * bands while typing). The work is `fileUnderOptionsProgram`.
 */
export const getFileUnderOptions = createServerFn()
  .validator(
    input(
      Schema.Struct({
        documentId: uuid,
        q: Schema.String.check(Schema.isMaxLength(120)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { fileUnderOptionsProgram } = await import('../documents/file-under')
    const { effectFn } = await import('./effect')
    return effectFn(fileUnderOptionsProgram)(u, data.documentId, data.q)
  })

/**
 * A kind outside `DOCUMENT_KINDS` dies in the validator, not the program: the
 * boundary is the one place the untrusted string exists.
 */
export const setDocumentKind = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        documentId: uuid,
        kind: Schema.Literals(DOCUMENT_KINDS),
      }),
    ),
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
  .validator(input(Schema.Struct({ documentId: uuid })))
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
