import { Effect, Schema } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entityAlias, term } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { normalizeName } from '@spaces/core/entities/normalize'

/**
 * Writing a term (SPA-75). The body of `createTerm` / `updateTerm`, moved out
 * of `lib/server/` when the write gained a behaviour (the Effect ratchet,
 * CONTEXT.md "Backend paradigm"), so a test calls it without a request.
 *
 * **Aliases are findable, not only matchable.** `term.aliases` is what the
 * glossary matcher reads, but the fused search query cannot see it: Cmd-K's
 * `name_hits` lane and `searchEntities` read `entity_alias(kind: 'name')`.
 * So every write that carries aliases diff-syncs them into that table —
 * `source_class: 'manual'`, `is_identity: false` — and "PUE" finds "Power
 * Usage Effectiveness" through a query nobody had to touch.
 *
 * The sync owns the manual name aliases of the term and nothing else: it
 * adds the ones the term gained, deletes the ones it lost, and leaves every
 * row of another kind or another source class exactly as it was. Rows are
 * keyed by `value_norm`, the form the lane matches on, so "PUE" and "pue"
 * are one alias and a re-save of the same list writes nothing.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export class TermWriteFailed extends Schema.TaggedError<TermWriteFailed>()(
  'TermWriteFailed',
  { cause: Schema.Defect() },
) {}

export type TermInput = {
  name: string
  aliases: Array<string>
  definitionMd: string
  spaceId: string | null
}

export type TermPatch = {
  id: string
  name?: string | undefined
  aliases?: Array<string> | undefined
  definitionMd?: string | undefined
  /** Omitted keeps the space; null makes the term global. */
  spaceId?: string | null | undefined
}

export type AliasDiff = { added: Array<string>; removed: Array<string> }

/**
 * Diff-sync the term's manual name aliases against `aliases`. Returns the
 * normalized values it added and removed — empty both ways when nothing
 * changed.
 */
export async function syncTermAliases(
  tx: Tx,
  termId: string,
  aliases: ReadonlyArray<string>,
): Promise<AliasDiff> {
  // First spelling wins for display; an alias that normalizes to nothing
  // ("Inc.") has nothing for the lane to match and is not written.
  const wanted = new Map<string, string>()
  for (const raw of aliases) {
    const value = raw.trim()
    const norm = normalizeName(value)
    if (norm && !wanted.has(norm)) wanted.set(norm, value)
  }

  const present = await tx
    .select({ id: entityAlias.id, valueNorm: entityAlias.valueNorm })
    .from(entityAlias)
    .where(
      and(
        eq(entityAlias.entityId, termId),
        eq(entityAlias.kind, 'name'),
        eq(entityAlias.sourceClass, 'manual'),
      ),
    )

  const stale = present.filter((r) => !wanted.has(r.valueNorm))
  if (stale.length > 0) {
    await tx.delete(entityAlias).where(
      inArray(
        entityAlias.id,
        stale.map((r) => r.id),
      ),
    )
  }

  const have = new Set(present.map((r) => r.valueNorm))
  const missing = [...wanted].filter(([norm]) => !have.has(norm))
  if (missing.length > 0) {
    await tx.insert(entityAlias).values(
      missing.map(([valueNorm, value]): typeof entityAlias.$inferInsert => ({
        entityId: termId,
        kind: 'name',
        value,
        valueNorm,
        isIdentity: false,
        sourceClass: 'manual',
      })),
    )
  }

  return {
    added: missing.map(([norm]) => norm),
    removed: stale.map((r) => r.valueNorm),
  }
}

const write = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TermWriteFailed({ cause }),
  })

export const createTermProgram = Effect.fn('createTermProgram')(function* (
  actorId: string,
  input: TermInput,
): Effect.fn.Return<{ id: string }, TermWriteFailed> {
  return yield* write(() =>
    db.transaction(async (tx) => {
      const ent = (
        await tx
          .insert(entity)
          .values({
            kind: 'term',
            canonicalName: input.name,
            createdBy: actorId,
          })
          .returning({ id: entity.id })
      ).at(0)
      if (!ent) throw new Error('term entity insert returned nothing')
      await tx.insert(term).values({
        entityId: ent.id,
        name: input.name,
        aliases: input.aliases,
        definitionMd: input.definitionMd,
        spaceId: input.spaceId,
      })
      await syncTermAliases(tx, ent.id, input.aliases)
      await tx.insert(activity).values({
        actorId,
        verb: 'term.created',
        subjectEntityId: ent.id,
      })
      return { id: ent.id }
    }),
  )
})

export const updateTermProgram = Effect.fn('updateTermProgram')(function* (
  patch: TermPatch,
): Effect.fn.Return<{ ok: true }, TermWriteFailed> {
  yield* write(() =>
    db.transaction(async (tx) => {
      await tx
        .update(term)
        .set({
          ...(patch.name ? { name: patch.name } : {}),
          ...(patch.aliases ? { aliases: patch.aliases } : {}),
          ...(patch.definitionMd !== undefined
            ? { definitionMd: patch.definitionMd }
            : {}),
          ...(patch.spaceId !== undefined ? { spaceId: patch.spaceId } : {}),
        })
        .where(eq(term.entityId, patch.id))
      if (patch.name) {
        await tx
          .update(entity)
          .set({ canonicalName: patch.name })
          .where(eq(entity.id, patch.id))
      }
      // A patch without aliases leaves them — and their rows — alone.
      if (patch.aliases) await syncTermAliases(tx, patch.id, patch.aliases)
    }),
  )
  return { ok: true }
})
