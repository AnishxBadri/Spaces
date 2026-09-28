import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import {
  isCoreIdentityKey,
  isNewAttributeType,
} from '@spaces/core/import/mapping'
import { isLedgerField } from '@spaces/core/import/ledger'
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
    /** SPA-168: a record reference column plans what it does not find. */
    createMissing: z.literal(true).optional(),
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
  /** SPA-170: accepted so the type is whole; a records batch refuses it. */
  z.object({
    target: z.literal('ledger'),
    field: z.string().refine(isLedgerField, 'Not an event field'),
  }),
])

/** The parsed input as the stored shape — optional keys omitted, never `undefined`. */
function toColumnTarget(t: z.infer<typeof columnTargetInput>): ColumnTarget {
  switch (t.target) {
    case 'name':
    case 'ignore':
      return { target: t.target }
    case 'attribute':
      return {
        target: 'attribute',
        attributeId: t.attributeId,
        ...(t.dateOrder ? { dateOrder: t.dateOrder } : {}),
        ...(t.createMissing ? { createMissing: true } : {}),
      }
    case 'identity':
      if (!isCoreIdentityKey(t.key)) throw new Error('Not an identity key')
      return { target: 'identity', key: t.key }
    case 'ledger':
      if (!isLedgerField(t.field)) throw new Error('Not an event field')
      return { target: 'ledger', field: t.field }
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

// ---------------------------------------------------------------------------
// Ledger mode (SPA-170, import-8) — the mapping onto event fields and its
// preview. Every program is `#/lib/import/ledger`'s, reached dynamically.
// ---------------------------------------------------------------------------

const INSTRUMENT_VALUES = [
  'priced',
  'safe_post_money',
  'safe_pre_money',
  'ccd',
] as const

const ledgerDecisionInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('instrument'),
    value: z.string().max(200),
    resolution: z.enum([...INSTRUMENT_VALUES, 'per_row']).nullable(),
  }),
  z.object({
    kind: z.literal('marksAsOf'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  }),
  z.object({
    kind: z.literal('currency'),
    code: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
  }),
  z.object({ kind: z.literal('dateOrder'), order: dateOrder }),
  z.object({ kind: z.literal('createMissing'), on: z.boolean() }),
])

/** Steps 2 and 3 of a ledger batch; null for a records batch. */
export const getLedgerImport = createServerFn()
  .validator(batchInput)
  .handler(async ({ data }) => {
    await requireUser()
    const { loadLedgerImportProgram, ledgerMessage } =
      await import('../import/ledger')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(loadLedgerImportProgram)(data.batchId)
    } catch (failure) {
      throw new Error(ledgerMessage(failure))
    }
  })

/** Continue from step 1 of a ledger batch: the first guess, written. */
export const beginLedgerMapping = createServerFn({ method: 'POST' })
  .validator(batchInput)
  .handler(async ({ data }) => {
    await requireUser()
    const { beginLedgerMappingProgram, ledgerMessage } =
      await import('../import/ledger')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(beginLedgerMappingProgram)(data.batchId)
    } catch (failure) {
      throw new Error(ledgerMessage(failure))
    }
  })

/** One event field onto a sheet column (or off it); answers what it replaced. */
export const mapLedgerField = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      batchId: uuid,
      field: z.string().refine(isLedgerField, 'Not an event field'),
      column: z.number().int().min(0).max(1000).nullable(),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    if (!isLedgerField(data.field)) throw new Error('Not an event field')
    const { mapLedgerFieldProgram, ledgerMessage } =
      await import('../import/ledger')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(mapLedgerFieldProgram)({
        batchId: data.batchId,
        field: data.field,
        column: data.column,
      })
    } catch (failure) {
      throw new Error(ledgerMessage(failure))
    }
  })

/** One decision from the decisions panel, stored on the mapping. */
export const setLedgerDecision = createServerFn({ method: 'POST' })
  .validator(z.object({ batchId: uuid, decision: ledgerDecisionInput }))
  .handler(async ({ data }) => {
    await requireUser()
    const { setLedgerDecisionProgram, ledgerMessage } =
      await import('../import/ledger')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(setLedgerDecisionProgram)(data)
    } catch (failure) {
      throw new Error(ledgerMessage(failure))
    }
  })

/** Continue from step 2 of a ledger batch: every row planned and stored. */
export const planLedgerImport = createServerFn({ method: 'POST' })
  .validator(batchInput)
  .handler(async ({ data }) => {
    await requireUser()
    const { planLedgerImportProgram, ledgerMessage } =
      await import('../import/ledger')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(planLedgerImportProgram)(data.batchId)
    } catch (failure) {
      throw new Error(ledgerMessage(failure))
    }
  })

/** A `per_row` instrument, chosen for one row from the preview. */
export const decideLedgerRow = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      batchId: uuid,
      rowNum: z.number().int().min(1),
      instrument: z.enum(INSTRUMENT_VALUES),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { decideLedgerRowProgram, ledgerMessage } =
      await import('../import/ledger')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(decideLedgerRowProgram)(data)
    } catch (failure) {
      throw new Error(ledgerMessage(failure))
    }
  })

// ---------------------------------------------------------------------------
// The commit step (SPA-169, import-7)
// ---------------------------------------------------------------------------

/** Spelled here rather than imported: `#/lib/import/commit` is server-only. */
const RECEIPT_FILTERS = ['all', 'failed'] as const

/**
 * Commit, or Retry failed rows (`onlyFailed`): refused with a reason while a
 * collision is undecided, otherwise `import.commit` is enqueued keyed by the
 * batch. `queued: false` means one is already queued or running.
 */
export const commitImport = createServerFn({ method: 'POST' })
  .validator(z.object({ batchId: uuid, onlyFailed: z.boolean() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { requestCommitProgram, commitMessage } =
      await import('../import/commit')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(requestCommitProgram)({
        batchId: data.batchId,
        userId: u.id,
        onlyFailed: data.onlyFailed,
      })
    } catch (failure) {
      throw new Error(commitMessage(failure))
    }
  })

/**
 * Step 4's data — counts, liveness, the last run and the first rows with
 * their outcomes — read from the database on every call, so the page polls
 * it while a commit runs and a reopened page recovers where it is. Null
 * until a commit has started.
 */
export const getImportReceipt = createServerFn()
  .validator(
    z.object({ batchId: uuid, filter: z.enum(RECEIPT_FILTERS).catch('all') }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { loadImportReceiptProgram, commitMessage } =
      await import('../import/commit')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(loadImportReceiptProgram)(data)
    } catch (failure) {
      throw new Error(commitMessage(failure))
    }
  })
