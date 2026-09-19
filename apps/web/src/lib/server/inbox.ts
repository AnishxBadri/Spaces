import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  attribute,
  duplicateCandidate,
  entity,
  entityAlias,
  entitySpace,
  link,
  objectDef,
} from '@spaces/db/schema'
import type { DuplicateReason, EntityValues } from '@spaces/db/schema/entities'
import { normalizeName } from '@spaces/core/entities/normalize'
import { mergeEntities } from '../entities/merge'
import { normalizeIdentityValue } from '../entities/resolve'
import { effectFn } from './effect'
import { provenanceOf, requireUser } from './shared'

/**
 * The review inbox (SPA-76) — one queue over typed rows, of which
 * `duplicate_candidate` is the only member today. `/inbox` is the surface;
 * `/dedupe` is a permanent redirect to it. Later lanes (the suggestion
 * table, spec-ai-substrate.md §10) join by adding a member to `InboxRow`
 * and a renderer to the page's `RENDERERS` map — never a second page.
 *
 * Reads are Effect programs through the `effectFn()` seam (CONTEXT.md
 * "Backend paradigm"): the handler checks the session, the program does the
 * work, nothing Effect-shaped escapes this file.
 */

class InboxQueryFailed extends Schema.TaggedError<InboxQueryFailed>()(
  'InboxQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InboxQueryFailed({ cause }),
  })

/**
 * The domain a record *says* it has when it holds no domain alias (SPA-97).
 *
 * The colliding side of an identity pair is exactly the side that lost the
 * claim, so it owns no `entity_alias` row — which left the pair card's
 * Domain row reading "—" for the very record that caused the pair. The
 * value is still on the record, in `entity.values`, under whichever slug
 * that object declared as its `domain` identity key; the slug is resolved
 * here rather than assumed, because an object names its own attributes.
 *
 * Core pairs are untouched by construction: the system company/person
 * objects carry no attribute with `options.identityKey`, so this answers
 * null for them and the card's alias lane is what renders.
 */
async function identityDomainOf(
  objectId: string | null,
  values: EntityValues,
): Promise<string | null> {
  if (objectId === null) return null
  const def = (
    await db
      .select({ slug: attribute.slug })
      .from(attribute)
      .where(
        and(
          eq(attribute.objectId, objectId),
          eq(attribute.archived, false),
          sql`${attribute.options} ->> 'identityKey' = 'domain'`,
        ),
      )
      .limit(1)
  ).at(0)
  if (!def) return null
  const raw = values[def.slug]
  if (typeof raw !== 'string' || raw.trim() === '') return null
  // Said in the same normal form the alias lane beside it is printed in,
  // so the two columns are comparable rather than merely both populated.
  return normalizeIdentityValue('domain', raw) ?? raw.trim()
}

export async function entityContext(id: string) {
  // The object row is left-joined, not looked up by kind: a custom record's
  // noun is its object's `singular`, and core rows carry an object row too
  // (`CORE_OBJECTS`), so one join answers for both. Research kinds — notes,
  // documents, terms — have no object row and answer null.
  const head = (
    await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        createdAt: entity.createdAt,
        objectId: entity.objectId,
        values: entity.values,
        objectSlug: objectDef.slug,
        objectSingular: objectDef.singular,
      })
      .from(entity)
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(eq(entity.id, id))
  ).at(0)
  if (!head) throw new Error('Record not found')
  // `objectId` and the values blob are read, not shipped: they answer the
  // identity-domain fallback below and nothing on the card, and a whole
  // record's values on every side of every pair is payload for no reader.
  const { objectId, values, ...card } = head
  // Provenance is the pair now, and the pair is only half an answer on its
  // own: "integration" names no integration. `provenanceOf` resolves the
  // ref to the capability id the operator installed.
  const provenance = await provenanceOf(id)
  const aliases = await db
    .select({ kind: entityAlias.kind, valueNorm: entityAlias.valueNorm })
    .from(entityAlias)
    .where(eq(entityAlias.entityId, id))
  const mentionCount =
    (
      await db
        .select({ value: count() })
        .from(link)
        .where(and(eq(link.toEntityId, id), eq(link.relation, 'mentions')))
    ).at(0)?.value ?? 0
  const spaceRows = await db
    .select({ name: entity.canonicalName })
    .from(entitySpace)
    .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
    .where(eq(entitySpace.entityId, id))
  return {
    ...card,
    ...provenance,
    createdAt: card.createdAt.toISOString(),
    domains: aliases.filter((a) => a.kind === 'domain').map((a) => a.valueNorm),
    identityDomain: await identityDomainOf(objectId, values),
    // "Other" is measured in the same normal form the aliases are written
    // in — `normalizeName`, not lowercase. Lowercasing leaves the legal
    // suffix on ("acme inc" vs the alias "acme"), so a record would list
    // its own current name as something it was also seen as. Renames write
    // a name alias now (SPA-63), so every record has that row.
    otherNames: aliases
      .filter(
        (a) => a.kind === 'name' && a.valueNorm !== normalizeName(card.name),
      )
      .map((a) => a.valueNorm),
    mentionCount,
    spaces: spaceRows.map((s) => s.name),
  }
}

/** One side of a pair: the record plus everything the card compares. */
export type InboxSide = Awaited<ReturnType<typeof entityContext>>

/**
 * A pair the sweep proposed, still open. The `kind` is the discriminant the
 * page dispatches on — it is stored nowhere, it is what this lane *is*.
 */
export type DuplicateCandidateRow = {
  kind: 'duplicate_candidate'
  id: string
  score: number
  reason: DuplicateReason
  a: InboxSide
  b: InboxSide
}

/**
 * Every row the inbox can hold. Add a lane by adding a member here and a
 * renderer in `routes/_app/inbox.tsx` — the queue, the count and the page
 * follow. Nothing else in the app switches on this union.
 */
export type InboxRow = DuplicateCandidateRow

export type InboxKind = InboxRow['kind']

/** `open` is the whole queue; `byKind` is what each lane contributes. */
export type InboxCounts = {
  open: number
  byKind: Record<InboxKind, number>
}

const listInboxProgram = Effect.fn('listInboxProgram')(
  function* (): Effect.fn.Return<Array<InboxRow>, InboxQueryFailed> {
    const rows = yield* query(() =>
      db
        .select()
        .from(duplicateCandidate)
        .where(eq(duplicateCandidate.status, 'open'))
        .orderBy(
          desc(duplicateCandidate.score),
          desc(duplicateCandidate.createdAt),
        ),
    )
    return yield* query(() =>
      Promise.all(
        rows.map(async (r): Promise<InboxRow> => ({
          kind: 'duplicate_candidate',
          id: r.id,
          score: r.score,
          reason: r.reason,
          a: await entityContext(r.entityA),
          b: await entityContext(r.entityB),
        })),
      ),
    )
  },
)

/**
 * One grouped query, not one query per lane and never the list itself:
 * Today used to call `listDuplicates()` — four queries per side per pair —
 * to read `.length`. The `kind` column is a literal because there is one
 * lane; the second lane makes this a `union all` of the same two columns,
 * and every caller keeps reading `byKind`.
 */
const countOpenInboxProgram = Effect.fn('countOpenInboxProgram')(
  function* (): Effect.fn.Return<InboxCounts, InboxQueryFailed> {
    const rows = yield* query(() =>
      db
        .select({
          kind: sql<InboxKind>`'duplicate_candidate'`.as('kind'),
          value: count(),
        })
        .from(duplicateCandidate)
        .where(eq(duplicateCandidate.status, 'open'))
        .groupBy(sql`1`),
    )
    const byKind: Record<InboxKind, number> = { duplicate_candidate: 0 }
    let open = 0
    for (const row of rows) {
      byKind[row.kind] = row.value
      open += row.value
    }
    return { open, byKind }
  },
)

export const listInbox = createServerFn().handler(async () => {
  await requireUser()
  return effectFn(listInboxProgram)()
})

export const countOpenInbox = createServerFn().handler(async () => {
  await requireUser()
  return effectFn(countOpenInboxProgram)()
})

export const mergeDuplicate = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      candidateId: z.string().uuid(),
      winnerId: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const cand = (
      await db
        .select()
        .from(duplicateCandidate)
        .where(eq(duplicateCandidate.id, data.candidateId))
    ).at(0)
    if (!cand || cand.status !== 'open') throw new Error('Candidate not open')
    if (data.winnerId !== cand.entityA && data.winnerId !== cand.entityB)
      throw new Error('Winner must be one of the pair')
    const loserId = data.winnerId === cand.entityA ? cand.entityB : cand.entityA
    await mergeEntities({
      winnerId: data.winnerId,
      loserId,
      mergedBy: u.id,
      candidateId: data.candidateId,
    })
    return { ok: true }
  })

export const dismissDuplicate = createServerFn({ method: 'POST' })
  .validator(z.object({ candidateId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    await db
      .update(duplicateCandidate)
      .set({ status: 'dismissed', resolvedBy: u.id, resolvedAt: new Date() })
      .where(eq(duplicateCandidate.id, data.candidateId))
    return { ok: true }
  })
