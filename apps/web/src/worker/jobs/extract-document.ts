import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { document } from '#/db/schema'
import { storage } from '#/lib/storage'
import { extractDocumentText } from '#/lib/documents/extract'

/**
 * document.extract — the reason the worker process exists. Parsing a 200-page
 * PDF or a 90MB deck is CPU-bound; run it on the web process and every other
 * request waits behind it.
 *
 * Writes extracted_text and tsv together in one statement: they must never
 * disagree, or search silently returns rows whose text says otherwise.
 */

const extractDocumentJob = z.object({
  documentId: z.string().uuid(),
})

export async function extractDocument(data: unknown): Promise<void> {
  const { documentId } = extractDocumentJob.parse(data)

  const row = (
    await db
      .select({
        blobSha: document.blobSha,
        filename: document.filename,
        mime: document.mime,
      })
      .from(document)
      .where(eq(document.entityId, documentId))
  ).at(0)

  if (!row) {
    console.warn(`[worker] document ${documentId} vanished before extraction`)
    return
  }
  if (!row.blobSha) {
    await fail(documentId, 'unsupported', 'No stored file to extract text from')
    return
  }

  let bytes: Uint8Array
  try {
    bytes = await storage().getBytes(row.blobSha)
  } catch (err) {
    await fail(
      documentId,
      'failed',
      `Blob ${row.blobSha.slice(0, 12)} unreadable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return
  }

  // Universal integrity backstop (2026-08): the local driver verifies on
  // write and enforcing S3 endpoints verify on PUT, but partially-compatible
  // targets (Garage) may not. We're holding the whole blob anyway, so
  // re-verify "same sha ⇒ same bytes" here — the invariant dedupe and the
  // immutable cache header lean on.
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== row.blobSha) {
    await fail(
      documentId,
      'failed',
      `Blob integrity check failed: stored bytes hash ${digest.slice(0, 12)}, expected ${row.blobSha.slice(0, 12)}. The storage backend accepted a corrupt upload.`,
    )
    return
  }

  const outcome = await extractDocumentText({
    bytes,
    filename: row.filename,
    mime: row.mime,
  })

  if (outcome.status !== 'done') {
    await fail(documentId, outcome.status, outcome.reason)
    return
  }

  await db
    .update(document)
    .set({
      extractedText: outcome.text,
      // 'english' matches the tsvector config used by the search indexes;
      // changing it here alone would make writes and queries disagree.
      tsv: sql`to_tsvector('english', ${outcome.text})`,
      extractionStatus: 'done',
      extractionError: null,
      extractedAt: new Date(),
    })
    .where(eq(document.entityId, documentId))

  console.log(
    `[worker] extracted ${outcome.text.length} chars from ${row.filename ?? documentId} (${outcome.format})`,
  )
}

async function fail(
  documentId: string,
  status: 'unsupported' | 'failed',
  reason: string,
): Promise<void> {
  await db
    .update(document)
    .set({
      extractionStatus: status,
      extractionError: reason.slice(0, 500),
      extractedAt: new Date(),
    })
    .where(eq(document.entityId, documentId))
  console.warn(`[worker] ${status} ${documentId}: ${reason}`)
}
