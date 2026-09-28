import { Effect } from 'effect'
import { asc, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, importBatch, importRow, objectDef } from '@spaces/db/schema'
import { identityKeysOf } from '@spaces/core/attributes/registry'
import {
  assignColumn,
  autoMap,
  columnStatus,
  fitMapping,
  isNewAttributeType,
  mappableAttributes,
  optionLabelsFrom,
  specFor,
  summarizeSpec,
  unparsedColumns,
  validateMapping,
} from '@spaces/core/import/mapping'
import { createAttributeProgram } from '#/lib/attributes/create'
import {
  ImportFailed,
  ImportNotFound,
  ImportRefused,
  stagedBatch,
} from './stage'
import type {
  AttributeType,
  CoreIdentityKey,
} from '@spaces/core/attributes/registry'
import type {
  ColumnStatus,
  ColumnTarget,
  ImportDateOrder,
  Mapping,
  MappingAttribute,
  MappingProblem,
  MappingRegistry,
  Replaced,
} from '@spaces/core/import/mapping'
import type { ImportFailure } from './stage'

/**
 * **Column mapping** (SPA-165, import-3) — the wizard's second step. Each
 * source column takes one target from the chosen object's registry; the
 * rules are `@spaces/core/import/mapping`'s, and this module is only their
 * persistence: the mapping lives on `import_batch.mapping`, written on every
 * change, so a reload resumes where the operator left it and the step is
 * read off the batch rather than out of component state.
 *
 * Beside `stage.ts` and outside `lib/server/` for the same reason: the
 * server-fns barrel ships plain exports to the browser, and the tests call
 * these programs without a request.
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ImportFailed({ cause }) })

/** The sentence a caller shows for a mapping failure. */
export function mappingMessage(failure: unknown): string {
  if (failure instanceof ImportRefused) return failure.reason
  if (failure instanceof ImportNotFound) return 'This import no longer exists'
  return 'Could not save the mapping'
}

// ---------------------------------------------------------------------------
// The registry the mapping is onto
// ---------------------------------------------------------------------------

export type MappingObject = {
  id: string
  singular: string
  plural: string
  registry: MappingRegistry
}

/** The target object's attributes and identity keys, read once. */
export const mappingObjectOf = Effect.fn('mappingObjectOf')(function* (
  objectId: string,
): Effect.fn.Return<MappingObject, ImportRefused | ImportFailed> {
  const object = yield* query(() =>
    db
      .select({
        id: objectDef.id,
        slug: objectDef.slug,
        singular: objectDef.singular,
        plural: objectDef.plural,
        isSystem: objectDef.isSystem,
        archived: objectDef.archived,
        identityKeys: objectDef.identityKeys,
      })
      .from(objectDef)
      .where(eq(objectDef.id, objectId))
      .then((rows) => rows.at(0)),
  )
  if (!object || object.archived)
    return yield* new ImportRefused({
      reason: 'That object is archived or no longer exists',
    })
  const attributes: Array<MappingAttribute> = yield* query(() =>
    db
      .select({
        id: attribute.id,
        slug: attribute.slug,
        name: attribute.name,
        type: attribute.type,
        options: attribute.options,
        archived: attribute.archived,
      })
      .from(attribute)
      .where(eq(attribute.objectId, objectId))
      .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt)),
  )
  return {
    id: object.id,
    singular: object.singular,
    plural: object.plural,
    registry: { attributes, identityKeys: identityKeysOf(object) },
  }
})

/** A staged records batch with its object chosen — the mapping step's precondition. */
const mappableBatch = Effect.fn('mappableBatch')(function* (batchId: string) {
  const batch = yield* stagedBatch(batchId)
  if (batch.mode !== 'records' || batch.targetObjectId === null)
    return yield* new ImportRefused({
      reason: 'Choose the object these rows go into first',
    })
  const object = yield* mappingObjectOf(batch.targetObjectId)
  return { batch, object }
})

function columnCountOf(batch: typeof importBatch.$inferSelect, width: number) {
  return batch.header?.length ?? width
}

const firstRowWidth = (batchId: string) =>
  query(() =>
    db
      .select({ cells: importRow.cells })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
      .orderBy(asc(importRow.rowNum))
      .limit(1)
      .then((rows) => rows.at(0)?.cells.length ?? 0),
  )

const writeMapping = (batchId: string, mapping: Mapping) =>
  query(() =>
    db.update(importBatch).set({ mapping }).where(eq(importBatch.id, batchId)),
  )

// ---------------------------------------------------------------------------
// Enter
// ---------------------------------------------------------------------------

/**
 * Continue from step 1: the first guess, from the header and the registry,
 * written to the batch. A batch already on step 2 keeps what it has.
 */
export const beginImportMappingProgram = Effect.fn('beginImportMappingProgram')(
  function* (batchId: string): Effect.fn.Return<Mapping, ImportFailure> {
    const { batch, object } = yield* mappableBatch(batchId)
    const width = columnCountOf(batch, yield* firstRowWidth(batchId))
    if (batch.mapping !== null) return fitMapping(batch.mapping, width)
    const headers = batch.header ?? Array.from({ length: width }, () => '')
    const mapping = fitMapping(autoMap(headers, object.registry), width)
    yield* writeMapping(batchId, mapping)
    return mapping
  },
)

// ---------------------------------------------------------------------------
// One column
// ---------------------------------------------------------------------------

/** Refuse a target the object does not offer — the picker never shows one. */
function offered(
  target: ColumnTarget,
  registry: MappingRegistry,
): string | null {
  switch (target.target) {
    case 'name':
    case 'ignore':
      return null
    case 'attribute': {
      const attr = mappableAttributes(registry).find(
        (a) => a.id === target.attributeId,
      )
      if (!attr) return 'That attribute is archived or cannot hold a cell'
      if (target.dateOrder !== undefined && attr.type !== 'date')
        return 'A date order belongs to a date column'
      return null
    }
    case 'identity':
      return registry.identityKeys.some((k) => k === target.key)
        ? null
        : `${target.key} does not identify these records`
    case 'new':
      return isNewAttributeType(target.type)
        ? null
        : 'A column cannot hold that type'
  }
}

export type MapColumnResult = { mapping: Mapping; replaced: Array<Replaced> }

/**
 * One column takes one target, written at once. A target another column
 * held is taken from it, and the answer names that column so the page can
 * say what the choice replaced.
 */
export const mapImportColumnProgram = Effect.fn('mapImportColumnProgram')(
  function* (input: {
    batchId: string
    column: number
    target: ColumnTarget
  }): Effect.fn.Return<MapColumnResult, ImportFailure> {
    const { batch, object } = yield* mappableBatch(input.batchId)
    if (batch.mapping === null)
      return yield* new ImportRefused({
        reason: 'Continue to the mapping step first',
      })
    const width = columnCountOf(batch, yield* firstRowWidth(input.batchId))
    if (input.column < 0 || input.column >= width)
      return yield* new ImportRefused({
        reason: 'That column is not in the sheet',
      })
    const refusal = offered(input.target, object.registry)
    if (refusal) return yield* new ImportRefused({ reason: refusal })
    const out = assignColumn(
      fitMapping(batch.mapping, width),
      input.column,
      input.target,
    )
    yield* writeMapping(input.batchId, out.mapping)
    return out
  },
)

export type CreateImportAttributeInput = {
  batchId: string
  column: number
  name: string
  type: AttributeType
  /** select / multi_select / status: the labels it is born with. */
  options: Array<string>
  dateOrder: ImportDateOrder | null
  userId: string
}

/**
 * `+ New attribute`, confirmed: the attribute is created on the target
 * object through the one create program — the same insert, slug rule and
 * option ids the attribute dialog gets — and the column maps onto it.
 */
export const createImportAttributeProgram = Effect.fn(
  'createImportAttributeProgram',
)(function* (
  input: CreateImportAttributeInput,
): Effect.fn.Return<MapColumnResult & { attributeId: string }, ImportFailure> {
  const { batch, object } = yield* mappableBatch(input.batchId)
  if (batch.mapping === null)
    return yield* new ImportRefused({
      reason: 'Continue to the mapping step first',
    })
  const width = columnCountOf(batch, yield* firstRowWidth(input.batchId))
  if (input.column < 0 || input.column >= width)
    return yield* new ImportRefused({
      reason: 'That column is not in the sheet',
    })
  if (!isNewAttributeType(input.type))
    return yield* new ImportRefused({
      reason: 'A column cannot hold that type',
    })
  const created = yield* createAttributeProgram({
    objectId: object.id,
    name: input.name,
    type: input.type,
    options: input.options.map((label) => ({ label })),
    createdBy: input.userId,
  }).pipe(
    Effect.catchTags({
      AttributeCreateRejected: (e) => new ImportRefused({ reason: e.message }),
      AttributeQueryFailed: (e) => new ImportFailed({ cause: e.cause }),
      ObjectQueryFailed: (e) => new ImportFailed({ cause: e.cause }),
      SystemObjectNotSeeded: (e) => new ImportFailed({ cause: e }),
    }),
  )
  const target: ColumnTarget =
    input.type === 'date' && input.dateOrder !== null
      ? {
          target: 'attribute',
          attributeId: created.id,
          dateOrder: input.dateOrder,
        }
      : { target: 'attribute', attributeId: created.id }
  const out = assignColumn(
    fitMapping(batch.mapping, width),
    input.column,
    target,
  )
  yield* writeMapping(input.batchId, out.mapping)
  return { ...out, attributeId: created.id }
})

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** Failures a head's click shows per column; the count is always whole. */
export const FAILURES_SHOWN = 100

export type ColumnView = {
  /** Non-blank cells that read, of `total`. Null when the column is ignored. */
  parsed: number | null
  total: number
  blanks: number
  status: ColumnStatus | null
  failureCount: number
  /** The first `FAILURES_SHOWN` refusals, by 1-based row number. */
  failures: Array<{ rowNum: number; raw: string; reason: string }>
  /** What a `+ New attribute` select / multi-select is offered as options. */
  labels: { select: Array<string>; multi: Array<string> }
}

export type ImportMappingView = {
  object: {
    id: string
    singular: string
    plural: string
    identityKeys: Array<CoreIdentityKey>
  }
  /** The attributes the picker offers, in registry order. */
  attributes: Array<MappingAttribute>
  mapping: Mapping
  columns: Array<ColumnView>
  /** What stops the step advancing — empty when it may. */
  problems: Array<MappingProblem>
}

/**
 * Step 2's data: the mapping, the registry it is onto, and each column read
 * over every staged row — the parse count its head shows, the refusals
 * behind it, and the distinct values a new select would be born with.
 * Null while the batch is still on step 1.
 */
export const loadImportMappingProgram = Effect.fn('loadImportMappingProgram')(
  function* (
    batchId: string,
  ): Effect.fn.Return<ImportMappingView | null, ImportFailure> {
    const batch = yield* query(() =>
      db
        .select()
        .from(importBatch)
        .where(eq(importBatch.id, batchId))
        .then((rows) => rows.at(0)),
    )
    if (!batch) return yield* new ImportNotFound()
    if (
      batch.mapping === null ||
      batch.mode !== 'records' ||
      batch.targetObjectId === null
    )
      return null
    const object = yield* mappingObjectOf(batch.targetObjectId)
    const rows = yield* query(() =>
      db
        .select({ rowNum: importRow.rowNum, cells: importRow.cells })
        .from(importRow)
        .where(eq(importRow.batchId, batchId))
        .orderBy(asc(importRow.rowNum)),
    )
    const width = columnCountOf(batch, rows.at(0)?.cells.length ?? 0)
    const mapping = fitMapping(batch.mapping, width)
    const registry = object.registry
    const summaries = mapping.map((target, i) => {
      const values = rows.map((r) => r.cells.at(i) ?? '')
      const spec = specFor(target, registry)
      return {
        values,
        spec,
        summary: spec ? summarizeSpec(spec, values) : null,
      }
    })
    const columns = summaries.map(
      ({ values, spec, summary }, i): ColumnView => {
        const blanks = values.filter((v) => v.trim() === '').length
        const labels = {
          select: optionLabelsFrom('select', values),
          multi: optionLabelsFrom('multi_select', values),
        }
        if (!spec || !summary)
          return {
            parsed: null,
            total: values.length - blanks,
            blanks,
            status: null,
            failureCount: 0,
            failures: [],
            labels,
          }
        return {
          parsed: summary.parsed,
          total: summary.total,
          blanks,
          status: columnStatus(mapping[i], spec, summary, blanks),
          failureCount: summary.failures.length,
          failures: summary.failures.slice(0, FAILURES_SHOWN).map((f) => ({
            rowNum: rows[f.row].rowNum,
            raw: f.raw,
            reason: f.reason,
          })),
          labels,
        }
      },
    )
    return {
      object: {
        id: object.id,
        singular: object.singular,
        plural: object.plural,
        identityKeys: [...registry.identityKeys],
      },
      attributes: mappableAttributes(registry),
      mapping,
      columns,
      problems: [
        ...validateMapping(mapping, registry, batch.header),
        ...unparsedColumns(
          mapping,
          summaries.map((s) => s.summary),
          batch.header,
        ),
      ],
    }
  },
)
