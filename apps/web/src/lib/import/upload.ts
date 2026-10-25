/**
 * The browser half of staged import. Unlike the document upload, the file is
 * posted to the server, which hashes it, rather than hashed here and PUT at
 * storage: the server must read it anyway (`readGrid`), and the app's one
 * WebCrypto digest stays the document lane's.
 *
 * Imports from `@spaces/core/documents` and the server-fns barrel only: no
 * `node:`, no drizzle, no Effect.
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
