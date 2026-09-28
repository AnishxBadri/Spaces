/**
 * The browser half of staged import (SPA-164) — the client module beside
 * `lib/documents/upload.ts`, and deliberately unlike it in one respect: the
 * file is **posted to the server**, which hashes it, rather than hashed here
 * and PUT at storage. An import is read on the server anyway (`readGrid`
 * needs the bytes), so there is no Node hop to save, and the repo's one
 * WebCrypto digest stays the document lane's.
 *
 * Like its neighbour it imports from `@spaces/core/documents` and the
 * server-fns barrel and nothing else: no `node:`, no drizzle, no Effect.
 */

import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import { stageImport } from '#/lib/server-fns'

export type UploadImportInput = {
  file: File
  mode: 'records' | 'ledger'
  targetObjectId: string | null
  /** Stage even when this file was imported before. */
  allowDuplicate: boolean
}

/** What `stageImport` answered: a new batch, or the earlier one. */
export type UploadImportResult = Awaited<ReturnType<typeof stageImport>>

export async function uploadImport({
  file,
  mode,
  targetObjectId,
  allowDuplicate,
}: UploadImportInput): Promise<UploadImportResult> {
  // The server refuses these too; saying so here saves sending the bytes.
  if (file.size === 0) throw new Error(`${file.name} is empty`)
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${file.name} is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit`,
    )
  }
  const form = new FormData()
  form.set('file', file)
  form.set('mode', mode)
  if (targetObjectId !== null) form.set('targetObjectId', targetObjectId)
  form.set('allowDuplicate', String(allowDuplicate))
  return await stageImport({ data: form })
}
