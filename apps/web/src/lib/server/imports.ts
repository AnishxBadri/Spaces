import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import { requireUser } from './shared'

/**
 * Staged import (SPA-164, import-2). Every handler is `requireUser()` plus a
 * program from `#/lib/import/stage`, reached by a **dynamic** import so
 * Effect, drizzle and the spreadsheet reader stay out of the client bundle:
 * this file is re-exported to the browser by the server-fns barrel and only
 * handler bodies are stripped (CLAUDE.md → Traps).
 */

const IMPORT_MODES = ['records', 'ledger'] as const

export type StageImportForm = {
  file: File
  mode: (typeof IMPORT_MODES)[number]
  targetObjectId: string | null
  allowDuplicate: boolean
}

const uuid = z.string().uuid()

/**
 * The file is posted to the server and hashed there — the browser never
 * takes the digest, so the one WebCrypto call stays the document lane's.
 * `FormData` is the transport TanStack Start reads natively for a POST.
 */
function readStageForm(data: FormData): StageImportForm {
  const file = data.get('file')
  if (!(file instanceof File)) throw new Error('Choose a file to import')
  const mode = z.enum(IMPORT_MODES).parse(data.get('mode') ?? 'records')
  const target = data.get('targetObjectId')
  const targetObjectId =
    typeof target === 'string' && target !== '' ? uuid.parse(target) : null
  return {
    file,
    mode,
    targetObjectId,
    allowDuplicate: data.get('allowDuplicate') === 'true',
  }
}

export const stageImport = createServerFn({ method: 'POST' })
  .validator((data: FormData) => readStageForm(data))
  .handler(async ({ data }) => {
    const u = await requireUser()
    // Refused before a byte is read into memory, naming the file.
    if (data.file.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${data.file.name} is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit`,
      )
    }
    const { stageImportProgram, importMessage } =
      await import('../import/stage')
    const { effectFn } = await import('./effect')
    const bytes = new Uint8Array(await data.file.arrayBuffer())
    try {
      return await effectFn(stageImportProgram)({
        filename: data.file.name,
        bytes,
        mime: data.file.type || null,
        mode: data.mode,
        targetObjectId: data.targetObjectId,
        allowDuplicate: data.allowDuplicate,
        userId: u.id,
      })
    } catch (failure) {
      throw new Error(importMessage(failure))
    }
  })

export const getImportBatch = createServerFn()
  .validator(z.object({ batchId: uuid }))
  .handler(async ({ data }) => {
    await requireUser()
    const { loadImportBatchProgram, importMessage } =
      await import('../import/stage')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(loadImportBatchProgram)(data.batchId)
    } catch (failure) {
      throw new Error(importMessage(failure))
    }
  })

export const defineImportBatch = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      batchId: uuid,
      mode: z.enum(IMPORT_MODES),
      targetObjectId: uuid.nullable(),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { defineImportBatchProgram, importMessage } =
      await import('../import/stage')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(defineImportBatchProgram)(data)
    } catch (failure) {
      throw new Error(importMessage(failure))
    }
  })

export const selectImportSheet = createServerFn({ method: 'POST' })
  .validator(z.object({ batchId: uuid, sheet: z.string().min(1).max(400) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { selectImportSheetProgram, importMessage } =
      await import('../import/stage')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(selectImportSheetProgram)(data)
    } catch (failure) {
      throw new Error(importMessage(failure))
    }
  })

export const discardImportBatch = createServerFn({ method: 'POST' })
  .validator(z.object({ batchId: uuid }))
  .handler(async ({ data }) => {
    await requireUser()
    const { discardImportBatchProgram, importMessage } =
      await import('../import/stage')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(discardImportBatchProgram)(data.batchId)
    } catch (failure) {
      throw new Error(importMessage(failure))
    }
  })
