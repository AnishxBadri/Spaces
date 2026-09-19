import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { document, documentChunk, entity, link } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { DOCUMENT_KINDS, MAX_UPLOAD_BYTES } from '@spaces/core/documents'
import { enqueue } from '../queue'
import { storage } from '../storage'
import { QUEUES } from '#/worker/queues'
import { requireUser } from './shared'

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
      /** The record this document is filed against. */
      attachTo: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()

    // The bytes must actually be in the store: a client that skipped the PUT
    // would otherwise leave a document row pointing at nothing.
    if (!(await storage().exists(data.sha))) {
      throw new Error('Upload incomplete — the file never reached storage')
    }

    const target = (
      await db
        .select({ id: entity.id, mergedIntoId: entity.mergedIntoId })
        .from(entity)
        .where(eq(entity.id, data.attachTo))
    ).at(0)
    if (!target) throw new Error('Record not found')
    if (target.mergedIntoId) throw new Error('That record has been merged away')

    // Same file, same record, twice — one row. Filing it again is almost
    // always a double-click or a re-drop, not a second document.
    const existing = (
      await db
        .select({ id: document.entityId })
        .from(document)
        .innerJoin(link, eq(link.fromEntityId, document.entityId))
        .where(
          and(
            eq(document.blobSha, data.sha),
            eq(link.toEntityId, data.attachTo),
            eq(link.relation, 'tagged_in'),
          ),
        )
    ).at(0)
    if (existing) return { id: existing.id, deduped: true }

    const id = await db.transaction(async (tx) => {
      const [ent] = await tx
        .insert(entity)
        .values({
          kind: 'document',
          canonicalName: data.filename,
          createdBy: u.id,
        })
        .returning({ id: entity.id })

      await tx.insert(document).values({
        entityId: ent.id,
        blobSha: data.sha,
        filename: data.filename,
        mime: data.mime ?? null,
        sizeBytes: data.sizeBytes,
        kind: data.kind,
        origin: 'upload',
        uploadedBy: u.id,
      })

      // Attachment goes through `link` — document.entity_id is the
      // document's own identity, not the record it belongs to.
      await tx.insert(link).values({
        fromEntityId: ent.id,
        toEntityId: data.attachTo,
        relation: 'tagged_in',
        source: 'manual',
        createdBy: u.id,
      })

      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'document.filed',
        subjectEntityId: data.attachTo,
        objectEntityId: ent.id,
        meta: { filename: data.filename, kind: data.kind },
      })

      return ent.id
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
        origin: document.origin,
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

    return rows.map((r) => ({
      ...r,
      filename: r.filename ?? 'Untitled file',
      createdAt: r.createdAt.toISOString(),
      uploadedByName: r.uploadedBy ? (names.get(r.uploadedBy) ?? null) : null,
      snippet: r.snippet?.replace(/\s+/g, ' ').trim() || null,
    }))
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
 */
export const deleteDocument = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const row = (
      await db
        .select({ blobSha: document.blobSha })
        .from(document)
        .where(eq(document.entityId, data.id))
    ).at(0)
    if (!row) return { ok: true }

    await db.transaction(async (tx) => {
      await tx
        .delete(documentChunk)
        .where(eq(documentChunk.documentId, data.id))
      await tx
        .delete(link)
        .where(or(eq(link.fromEntityId, data.id), eq(link.toEntityId, data.id)))
      await tx
        .delete(activity)
        .where(
          or(
            eq(activity.subjectEntityId, data.id),
            eq(activity.objectEntityId, data.id),
          ),
        )
      await tx.delete(document).where(eq(document.entityId, data.id))
      await tx.delete(entity).where(eq(entity.id, data.id))
    })

    if (row.blobSha) {
      const [{ value: remaining }] = await db
        .select({ value: count() })
        .from(document)
        .where(eq(document.blobSha, row.blobSha))
      if (remaining === 0) await storage().delete(row.blobSha)
    }
    return { ok: true }
  })
