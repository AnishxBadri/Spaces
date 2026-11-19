import { createServerFn } from '@tanstack/react-start'
import { Effect, Option, Schema } from 'effect'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import {
  isCoreIdentityKey,
  isNewAttributeType,
} from '@spaces/core/import/mapping'
import { isLedgerField } from '@spaces/core/import/ledger'
import { requireUser } from './shared'
import { input } from './input'
import type { ColumnTarget } from '@spaces/core/import/mapping'

/**
 * Staged import. Every handler is `requireUser()` plus an import program,
 * reached by a dynamic import so Effect, drizzle and the spreadsheet reader
 * stay out of the client bundle: this file is re-exported to the browser by
 * the server-fns barrel and only handler bodies are stripped.
 */

const IMPORT_MODES = ['records', 'ledger'] as const

export type StageImportForm = {
  file: File
  mode: (typeof IMPORT_MODES)[number]
  targetObjectId: string | null
  allowDuplicate: boolean
}

const uuid = Schema.String.check(Schema.isUUID())
const importMode = Schema.Literals(IMPORT_MODES)

/**
 * A list filter: one of `filters`, and anything else — a stale link, a
 * missing key — reads as `all` rather than refusing the page.
 */
const orAll = <const TFilters extends readonly ['all', ...Array<string>]>(
  filters: TFilters,
) =>
  Schema.Literals(filters).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(filters[0]))),
    Schema.withDecodingDefault(Effect.succeed(filters[0])),
  )

const batchInput = input(Schema.Struct({ batchId: uuid }))

/**
 * The file is posted to the server and hashed there — the browser never
 * takes the digest, so the one WebCrypto call stays the document lane's.
 * `FormData` is the transport TanStack Start reads natively for a POST.
 */
function readStageForm(data: FormData): StageImportForm {
  const file = data.get('file')
  if (!(file instanceof File)) throw new Error('Choose a file to import')
  const mode = Schema.decodeUnknownSync(importMode)(
    data.get('mode') ?? 'records',
  )
  const target = data.get('targetObjectId')
  const targetObjectId =
    typeof target === 'string' && target !== ''
      ? Schema.decodeUnknownSync(uuid)(target)
      : null
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
  .validator(batchInput)
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
    input(
      Schema.Struct({
        batchId: uuid,
        mode: importMode,
        targetObjectId: Schema.NullOr(uuid),
      }),
    ),
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
  .validator(
    input(
      Schema.Struct({
        batchId: uuid,
        sheet: Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(400),
        ),
      }),
    ),
  )
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
  .validator(batchInput)
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
// The mapping step
// ---------------------------------------------------------------------------

const dateOrder = Schema.Literals(['dmy', 'mdy'])

/** A column index on the sheet. */
const columnIndex = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 1000 }),
)

/** A one-based sheet row. */
const rowNum = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const newAttributeType = Schema.String.check(
  Schema.makeFilter(isNewAttributeType, {
    message: 'Not a type a cell can hold',
  }),
)

const ledgerField = Schema.String.check(
  Schema.makeFilter(isLedgerField, { message: 'Not an event field' }),
)

const optionLabel = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(60),
)

const attributeName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
)

/**
 * One column's target at the boundary. The identity key and the new
 * attribute's type are checked against core's own lists
 * (`isCoreIdentityKey`, `isNewAttributeType`) rather than spelled here, so
 * the repo keeps one notion of what identifies a record.
 */
const columnTargetInput = Schema.Union([
  Schema.Struct({ target: Schema.Literal('name') }),
  Schema.Struct({
    target: Schema.Literal('attribute'),
    attributeId: uuid,
    dateOrder: Schema.optional(dateOrder),
    /** A record reference column plans what it does not find. */
    createMissing: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    target: Schema.Literal('identity'),
    key: Schema.String.check(
      Schema.makeFilter(isCoreIdentityKey, {
        message: 'Not an identity key',
      }),
    ),
  }),
  Schema.Struct({ target: Schema.Literal('ignore') }),
  Schema.Struct({
    target: Schema.Literal('new'),
    name: attributeName,
    type: newAttributeType,
    options: Schema.optional(
      Schema.Array(optionLabel).check(Schema.isMaxLength(50)),
    ),
    dateOrder: Schema.optional(dateOrder),
  }),
  /** Accepted so the type is whole; a records batch refuses it. */
  Schema.Struct({
    target: Schema.Literal('ledger'),
    field: ledgerField,
  }),
])

/** The parsed input as the stored shape — optional keys omitted, never `undefined`. */
function toColumnTarget(t: typeof columnTargetInput.Type): ColumnTarget {
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
        ...(t.options ? { options: [...t.options] } : {}),
        ...(t.dateOrder ? { dateOrder: t.dateOrder } : {}),
      }
    }
  }
}

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
    input(
      Schema.Struct({
        batchId: uuid,
        column: columnIndex,
        target: columnTargetInput,
      }),
    ),
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
    input(
      Schema.Struct({
        batchId: uuid,
        column: columnIndex,
        name: attributeName,
        type: newAttributeType,
        options: Schema.Array(optionLabel).check(Schema.isMaxLength(50)),
        dateOrder: Schema.NullOr(dateOrder),
      }),
    ),
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
        options: [...data.options],
        dateOrder: data.dateOrder,
        userId: u.id,
      })
      return { attributeId: out.attributeId, replaced: out.replaced }
    } catch (failure) {
      throw new Error(mappingMessage(failure))
    }
  })

// ---------------------------------------------------------------------------
// The preview step
// ---------------------------------------------------------------------------

/** Spelled here rather than imported: the plan module is server-only. */
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
    input(Schema.Struct({ batchId: uuid, filter: orAll(PREVIEW_FILTERS) })),
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
    input(
      Schema.Struct({
        batchId: uuid,
        rowNum,
        decision: Schema.Literals(['keep-first', 'keep-second', 'skip-both']),
      }),
    ),
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
// Ledger mode: the mapping onto event fields and its preview. Every program
// is reached dynamically.
// ---------------------------------------------------------------------------

const INSTRUMENT_VALUES = [
  'priced',
  'safe_post_money',
  'safe_pre_money',
  'ccd',
] as const

const ledgerDecisionInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('instrument'),
    value: Schema.String.check(Schema.isMaxLength(200)),
    resolution: Schema.NullOr(
      Schema.Literals([...INSTRUMENT_VALUES, 'per_row']),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal('marksAsOf'),
    date: Schema.NullOr(
      Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal('currency'),
    code: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))),
  }),
  Schema.Struct({ kind: Schema.Literal('dateOrder'), order: dateOrder }),
  Schema.Struct({ kind: Schema.Literal('createMissing'), on: Schema.Boolean }),
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
    input(
      Schema.Struct({
        batchId: uuid,
        field: ledgerField,
        column: Schema.NullOr(columnIndex),
      }),
    ),
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
  .validator(
    input(Schema.Struct({ batchId: uuid, decision: ledgerDecisionInput })),
  )
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
    input(
      Schema.Struct({
        batchId: uuid,
        rowNum,
        instrument: Schema.Literals(INSTRUMENT_VALUES),
      }),
    ),
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
// The commit step
// ---------------------------------------------------------------------------

/** Spelled here rather than imported: the commit module is server-only. */
const RECEIPT_FILTERS = ['all', 'failed'] as const

/**
 * Commit, or Retry failed rows (`onlyFailed`): refused with a reason while a
 * collision is undecided, otherwise `import.commit` is enqueued keyed by the
 * batch. `queued: false` means one is already queued or running.
 */
export const commitImport = createServerFn({ method: 'POST' })
  .validator(
    input(Schema.Struct({ batchId: uuid, onlyFailed: Schema.Boolean })),
  )
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
    input(Schema.Struct({ batchId: uuid, filter: orAll(RECEIPT_FILTERS) })),
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
