import { Effect, Schema } from 'effect'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import { ENTITY_REFS } from '@spaces/db/entity-refs'
import type { EntityRef } from '@spaces/db/entity-refs'
import {
  company,
  document,
  entity,
  note,
  person,
  space,
  term,
} from '@spaces/db/schema'

/**
 * Delete executor (SPA-77). The third consumer of ENTITY_REFS, beside the
 * merge executor and the context assembler: every column that points at an
 * entity declares `del`, and this walks the list rather than hand-listing
 * tables. `deleteDocument` and `deleteTerm` each carried such a hand-list,
 * and both had already fallen behind it — neither cleared `entity_space`,
 * `task_entity`, `interaction_entity` or `duplicate_candidate`, so a
 * document tagged into a space could not be deleted at all.
 *
 * One transaction, three phases:
 *
 *  1. every `block` column is checked before a single row is touched, so a
 *     refusal costs nothing and rolls back nothing;
 *  2. every `cascade` / `orphan` column is applied, in registry order;
 *  3. the side-table row and the entity row go last.
 *
 * Adding an entity-referencing column therefore means adding a registry
 * entry, not editing this file.
 *
 * **Side tables dispatch on kind, they are not passed in by the caller.**
 * The registry deliberately cannot answer for them — a side table's own
 * single-column PK *is* the entity, so the membership rule excludes it — and
 * of the two designs the issue offers, dispatch is the one that cannot be
 * forgotten: a caller that omits its side table gets a foreign-key violation
 * at run time, whereas a kind missing from `SIDE_TABLES` below is a type
 * error, because the map is keyed by every `entity.kind`.
 */

/** The delete was refused; `key` is the ENTITY_REFS entry that refused it. */
export class Blocked extends Schema.TaggedError<Blocked>()('Blocked', {
  key: Schema.String,
  reason: Schema.String,
}) {}

export class DeleteQueryFailed extends Schema.TaggedError<DeleteQueryFailed>()(
  'DeleteQueryFailed',
  { cause: Schema.Defect() },
) {}

/**
 * Thrown inside the transaction so drizzle rolls it back, caught on the way
 * out and turned into the typed `Blocked` failure. A refusal has to travel as
 * an exception because the rollback is the point: returning a value from the
 * transaction callback commits it.
 */
class BlockedRollback extends Error {
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(`${key}: ${reason}`)
    this.name = 'BlockedRollback'
  }
}

type EntityKind = (typeof entity.kind.enumValues)[number]

type SideTable = { table: PgTable; column: PgColumn }

/**
 * The per-kind side table, one entry per `entity_kind`. `deal` and `custom`
 * have no side table — a deal is its entity row and its values, and custom
 * records share the `custom` kind and are told apart by `object_id`. Both
 * are `null` here on purpose: a kind added to the enum without a decision
 * here fails to compile.
 */
const SIDE_TABLES: Record<EntityKind, SideTable | null> = {
  company: { table: company, column: company.entityId },
  person: { table: person, column: person.entityId },
  deal: null,
  space: { table: space, column: space.entityId },
  note: { table: note, column: note.entityId },
  document: { table: document, column: document.entityId },
  term: { table: term, column: term.entityId },
  custom: null,
}

/**
 * TS property name for a column — `update().set()` is keyed by property, not
 * by SQL name. merge.ts carries the same six lines for the same reason;
 * sharing them would make every delete import the merge executor and its
 * import-time handler check.
 */
function propertyKey(table: PgTable, column: PgColumn): string {
  const hit = Object.entries(getTableColumns(table)).find(
    ([, c]) => c.name === column.name,
  )
  if (!hit) throw new Error(`column ${column.name} not on table`)
  return hit[0]
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Does any row still point at this entity through `ref`? */
async function hasRows(tx: Tx, ref: EntityRef, id: string): Promise<boolean> {
  const rows = await tx
    .select({ one: sql`1` })
    .from(ref.table)
    .where(eq(ref.column, id))
    .limit(1)
  return rows.length > 0
}

/**
 * The first `block` entry that still has rows, or null. Phase 1 of the
 * delete, lifted out so a caller can ask the question without attempting the
 * delete — a confirm dialog that offers a Delete button the registry is
 * going to refuse is a dialog that lies. Registry order is the answer order:
 * the first refusal wins, exactly as it does inside the transaction.
 */
async function findRefusal(
  tx: Tx,
  id: string,
): Promise<{ key: string; reason: string } | null> {
  for (const ref of ENTITY_REFS) {
    if (ref.del.kind !== 'block') continue
    if (await hasRows(tx, ref, id))
      return { key: ref.key, reason: ref.del.reason }
  }
  return null
}

async function runDelete(id: string): Promise<{ deleted: boolean }> {
  return db.transaction(async (tx) => {
    const target = (
      await tx
        .select({ kind: entity.kind })
        .from(entity)
        .where(eq(entity.id, id))
    ).at(0)
    // Deleting what is already gone is the same outcome, not an error: both
    // callers may be a second click on the same row.
    if (!target) return { deleted: false }

    // Phase 1 — refusals first, so nothing is half-deleted when one fires.
    const refusal = await findRefusal(tx, id)
    if (refusal) throw new BlockedRollback(refusal.key, refusal.reason)

    // Phase 2 — the registry, one pass, no table named here.
    for (const ref of ENTITY_REFS) {
      switch (ref.del.kind) {
        case 'cascade':
          await tx.delete(ref.table).where(eq(ref.column, id))
          break
        case 'orphan':
          await tx
            .update(ref.table)
            .set({ [propertyKey(ref.table, ref.column)]: null })
            .where(eq(ref.column, id))
          break
        case 'block':
        case 'none':
          break
      }
    }

    // Phase 3 — the row that *is* the entity, then the entity.
    const side = SIDE_TABLES[target.kind]
    if (side) await tx.delete(side.table).where(eq(side.column, id))
    await tx.delete(entity).where(eq(entity.id, id))
    return { deleted: true }
  })
}

/**
 * Delete one entity and everything the registry says dies with it.
 * `{ deleted: false }` means there was no such entity.
 */
export const deleteEntityProgram = Effect.fn('deleteEntityProgram')(function* (
  id: string,
): Effect.fn.Return<{ deleted: boolean }, Blocked | DeleteQueryFailed> {
  return yield* Effect.tryPromise({
    try: () => runDelete(id),
    catch: (cause) =>
      cause instanceof BlockedRollback
        ? new Blocked({ key: cause.key, reason: cause.reason })
        : new DeleteQueryFailed({ cause }),
  })
})

/**
 * What `deleteEntityProgram` would refuse with, without attempting it — a
 * `Blocked` in the *success* channel, because "nothing refuses this" is an
 * answer, not a failure. The delete still asks the same question inside its
 * own transaction: this is for a confirm dialog that has to name the reason
 * before it offers the button, never a substitute for the check.
 */
export const deleteRefusalProgram = Effect.fn('deleteRefusalProgram')(
  function* (id: string): Effect.fn.Return<Blocked | null, DeleteQueryFailed> {
    return yield* Effect.tryPromise({
      try: async () => {
        const refusal = await db.transaction((tx) => findRefusal(tx, id))
        return refusal === null ? null : new Blocked(refusal)
      },
      catch: (cause) => new DeleteQueryFailed({ cause }),
    })
  },
)
