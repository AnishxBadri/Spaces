import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { document } from '#/db/schema'
import { blobPath } from '#/lib/storage/local'
import { extractDocumentText } from '#/lib/documents/extract'
import { readFile } from 'node:fs/promises'

/**
 * document.extract — the reason the worker process exists. Parsing a 200-page
 * PDF or a 90MB deck is CPU-bound; run it on the web process and every other
 * request waits behind it.
 *
 * Writes extracted_text and tsv together in one statement: they must never
 * disagree, or search silently returns rows whose text says otherwise.
 */

export const extractDocumentJob = z.object({
  documentId: z.string().uuid(),
})

export async function extractDocument(data: unknown): Promise<void> {
  const { documentId } = extractDocumentJob.parse(data)

  const [row] = await db
    .select({
      blobSha: document.blobSha,
      filename: document.filename,
      mime: document.mime,
    })
    .from(document)
    .where(eq(document.entityId, documentId))

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
    bytes = new Uint8Array(await readFile(blobPath(row.blobSha)))
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
