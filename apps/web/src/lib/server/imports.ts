import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import {
  isCoreIdentityKey,
  isNewAttributeType,
} from '@spaces/core/import/mapping'
import { requireUser } from './shared'
import type { ColumnTarget } from '@spaces/core/import/mapping'

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

// ---------------------------------------------------------------------------
// The mapping step (SPA-165, import-3)
// ---------------------------------------------------------------------------

const dateOrder = z.enum(['dmy', 'mdy'])

/**
 * One column's target at the boundary. The identity key and the new
 * attribute's type are checked against core's own lists
 * (`isCoreIdentityKey`, `isNewAttributeType`) rather than spelled here, so
 * the repo keeps one notion of what identifies a record.
 */
const columnTargetInput = z.discriminatedUnion('target', [
  z.object({ target: z.literal('name') }),
  z.object({
    target: z.literal('attribute'),
    attributeId: uuid,
    dateOrder: dateOrder.optional(),
  }),
  z.object({
    target: z.literal('identity'),
    key: z.string().refine(isCoreIdentityKey, 'Not an identity key'),
  }),
  z.object({ target: z.literal('ignore') }),
  z.object({
    target: z.literal('new'),
    name: z.string().trim().min(1).max(80),
    type: z.string().refine(isNewAttributeType, 'Not a type a cell can hold'),
    options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    dateOrder: dateOrder.optional(),
  }),
])

/** The parsed input as the stored shape — optional keys omitted, never `undefined`. */
function toColumnTarget(t: z.infer<typeof columnTargetInput>): ColumnTarget {
  switch (t.target) {
    case 'name':
    case 'ignore':
      return { target: t.target }
    case 'attribute':
      return t.dateOrder
        ? {
            target: 'attribute',
            attributeId: t.attributeId,
            dateOrder: t.dateOrder,
          }
        : { target: 'attribute', attributeId: t.attributeId }
    case 'identity':
      if (!isCoreIdentityKey(t.key)) throw new Error('Not an identity key')
      return { target: 'identity', key: t.key }
    case 'new': {
      if (!isNewAttributeType(t.type))
        throw new Error('Not a type a cell can hold')
      return {
        target: 'new',
        name: t.name,
        type: t.type,
        ...(t.options ? { options: t.options } : {}),
        ...(t.dateOrder ? { dateOrder: t.dateOrder } : {}),
      }
    }
  }
}

const batchInput = z.object({ batchId: uuid })

/** Step 2's data; null while the batch is on step 1. */
export const getImportMapping = createServerFn()
  .validator(batchInput)
  .handler(async ({ data }) => {
    await requireUser()
    const { loadImportMappingProgram, mappingMessage } =
      await import('../import/mapping')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(loadImportMappingProgram)(data.batchId)
    } catch (failure) {
      throw new Error(mappingMessage(failure))
    }
  })

/** Continue from step 1: the first guess, written to the batch. */
export const beginImportMapping = createServerFn({ method: 'POST' })
  .validator(batchInput)
  .handler(async ({ data }) => {
    await requireUser()
    const { beginImportMappingProgram, mappingMessage } =
      await import('../import/mapping')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(beginImportMappingProgram)(data.batchId)
    } catch (failure) {
      throw new Error(mappingMessage(failure))
    }
  })

/** One column's target, written at once; answers what it replaced. */
export const mapImportColumn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      batchId: uuid,
      column: z.number().int().min(0).max(1000),
      target: columnTargetInput,
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { mapImportColumnProgram, mappingMessage } =
      await import('../import/mapping')
    const { effectFn } = await import('./effect')
    try {
      const out = await effectFn(mapImportColumnProgram)({
        batchId: data.batchId,
        column: data.column,
        target: toColumnTarget(data.target),
      })
      return { replaced: out.replaced }
    } catch (failure) {
      throw new Error(mappingMessage(failure))
    }
  })

/**
 * `+ New attribute`, confirmed: created on the target object through the
 * attribute-create program and mapped. Additive, so member-level, exactly
 * as `createAttribute` is.
 */
export const createImportAttribute = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      batchId: uuid,
      column: z.number().int().min(0).max(1000),
      name: z.string().trim().min(1).max(80),
      type: z.string().refine(isNewAttributeType, 'Not a type a cell can hold'),
      options: z.array(z.string().trim().min(1).max(60)).max(50),
      dateOrder: dateOrder.nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    if (!isNewAttributeType(data.type))
      throw new Error('Not a type a cell can hold')
    const { createImportAttributeProgram, mappingMessage } =
      await import('../import/mapping')
    const { effectFn } = await import('./effect')
    try {
      const out = await effectFn(createImportAttributeProgram)({
        batchId: data.batchId,
        column: data.column,
        name: data.name,
        type: data.type,
        options: data.options,
        dateOrder: data.dateOrder,
        userId: u.id,
      })
      return { attributeId: out.attributeId, replaced: out.replaced }
    } catch (failure) {
      throw new Error(mappingMessage(failure))
    }
  })

// ---------------------------------------------------------------------------
// The preview step (SPA-167, import-5)
// ---------------------------------------------------------------------------

/** Spelled here rather than imported: `#/lib/import/plan` is server-only. */
const PREVIEW_FILTERS = ['all', 'create', 'attach', 'decide', 'noland'] as const

/** Continue from step 2: every row planned and stored; answers the counts. */
export const planImport = createServerFn({ method: 'POST' })
  .validator(batchInput)
  .handler(async ({ data }) => {
    await requireUser()
    const { planImportProgram, planMessage } = await import('../import/plan')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(planImportProgram)(data.batchId)
    } catch (failure) {
      throw new Error(planMessage(failure))
    }
  })

/** Step 3's data, read off the stored plans; null unless the batch is planned. */
export const getImportPreview = createServerFn()
  .validator(
    z.object({ batchId: uuid, filter: z.enum(PREVIEW_FILTERS).catch('all') }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { loadImportPreviewProgram, planMessage } =
      await import('../import/plan')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(loadImportPreviewProgram)(data)
    } catch (failure) {
      throw new Error(planMessage(failure))
    }
  })

/** One in-file collision's decision, stored on every row of it. */
export const decideImportCollision = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      batchId: uuid,
      rowNum: z.number().int().min(1),
      decision: z.enum(['keep-first', 'keep-second', 'skip-both']),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { decideImportCollisionProgram, planMessage } =
      await import('../import/plan')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(decideImportCollisionProgram)(data)
    } catch (failure) {
      throw new Error(planMessage(failure))
    }
  })

/** Back to mapping: the plan is discarded and the batch staged again. */
export const reopenImportMapping = createServerFn({ method: 'POST' })
  .validator(batchInput)
  .handler(async ({ data }) => {
    await requireUser()
    const { reopenImportMappingProgram, planMessage } =
      await import('../import/plan')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(reopenImportMappingProgram)(data.batchId)
    } catch (failure) {
      throw new Error(planMessage(failure))
    }
  })
