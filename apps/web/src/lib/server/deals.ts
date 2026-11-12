import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { entity, link } from '@spaces/db/schema'
import { mandate } from '@spaces/db/schema/workspace'
import { jsonString } from '@spaces/core/json'
import type { EntityValues } from '@spaces/db/schema/entities'
import type { RowStats } from '#/lib/views/stat-fields'
import { requireUser } from './shared'
import { recordSpaces } from '#/lib/spaces/filed-in'
import { input } from './input'
import { serverQuery } from './query'

const uuid = Schema.String.check(Schema.isUUID())

const createDealInput = Schema.Struct({
  companyId: uuid,
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  stage: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
  value: Schema.optional(Schema.Finite),
  source: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
})

class DealNotFound extends Schema.TaggedError<DealNotFound>()('DealNotFound', {
  message: Schema.String,
}) {}

/**
 * A deal from the create dialog. The birth (entity, values, activity, and the
 * Invested → holding seam) is `birthDealProgram`, the same program an
 * imported Deals row goes through; this is its thin caller.
 */
export const createDeal = createServerFn({ method: 'POST' })
  .validator(input(createDealInput))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { birthDealProgram, dealFromDialog } = await import('../deals/birth')
    const { effectFn } = await import('./effect')
    const born = await effectFn(birthDealProgram)(dealFromDialog(data, u.id))
    return { id: born.id }
  })

/** One row of the deals table, values already the column's type. */
type DealTableRow = {
  id: string
  name: string
  values: EntityValues
  createdAt: string
  /** Last contact and the rest, from `interaction_stat`. */
  stats: RowStats
}

/**
 * Deal rows with referenced records resolved for display: values hold
 * uuids; the table wants names. One pass over reference links, and one over
 * the interaction stats for Last contact.
 */
const listDealsTableProgram = Effect.fn('listDealsTableProgram')(function* () {
  // The same set the view chips count over.
  const { listScope } = yield* Effect.promise(() => import('../views/scope'))
  const rows = yield* serverQuery(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        createdAt: entity.createdAt,
      })
      .from(entity)
      .where(listScope({ kind: 'deal' }))
      .orderBy(desc(entity.createdAt)),
  )

  if (rows.length === 0) {
    const empty: Array<DealTableRow> = []
    const none: Record<string, string> = {}
    return { rows: empty, refNames: {}, userNames: {}, pictures: none }
  }
  const dealIds = rows.map((r) => r.id)
  const refs = yield* serverQuery(() =>
    db
      .select({
        fromId: link.fromEntityId,
        toId: link.toEntityId,
        attrSlug: link.attrSlug,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .where(
        and(
          eq(link.relation, 'references'),
          inArray(link.fromEntityId, dealIds),
        ),
      ),
  )
  const refNames = new Map<string, { id: string; name: string; kind: string }>()
  for (const r of refs)
    refNames.set(r.toId, { id: r.toId, name: r.name, kind: r.kind })

  const users = yield* serverQuery(() =>
    db.select({ id: user.id, name: user.name }).from(user),
  )
  const { statsFor } = yield* Effect.promise(() => import('../views/directory'))
  const stats = yield* serverQuery(() => statsFor(dealIds))
  // The board card draws its company's picture in place of the mark. A
  // storage failure reaches the caller as the storage threw it.
  const { pictureUrlsFor } = yield* Effect.promise(
    () => import('../records/pictures'),
  )
  const pictures = yield* Effect.promise(() =>
    pictureUrlsFor(
      [...refNames.values()]
        .filter((r) => r.kind === 'company')
        .map((r) => r.id),
    ),
  )

  return {
    rows: rows.map((r): DealTableRow => ({
      id: r.id,
      name: r.name,
      values: r.values,
      createdAt: r.createdAt.toISOString(),
      stats: stats.get(r.id) ?? {
        lastContact: null,
        lastEmail: null,
        nextMeeting: null,
      },
    })),
    refNames: Object.fromEntries(refNames),
    userNames: Object.fromEntries(users.map((u) => [u.id, u.name])),
    pictures: Object.fromEntries(pictures),
  }
})

export const listDealsTable = createServerFn().handler(async () => {
  await requireUser()
  return Effect.runPromise(listDealsTableProgram())
})

const getDealProgram = Effect.fn('getDealProgram')(function* (id: string) {
  const head = (yield* serverQuery(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        mergedIntoId: entity.mergedIntoId,
        values: entity.values,
        createdAt: entity.createdAt,
      })
      .from(entity)
      .where(and(eq(entity.id, id), eq(entity.kind, 'deal'))),
  )).at(0)
  if (!head) return yield* new DealNotFound({ message: 'Deal not found' })

  // Resolve referenced entities + users for display.
  const refs = yield* serverQuery(() =>
    db
      .select({
        toId: link.toEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .where(and(eq(link.fromEntityId, id), eq(link.relation, 'references'))),
  )
  const users = yield* serverQuery(() =>
    db.select({ id: user.id, name: user.name }).from(user),
  )

  // Outside-mandate hint: rendered on the deal
  // record only — where the invest/pass judgment happens. A hint, never a
  // block; null when there is no mandate, no stages, or no company stage.
  let outsideMandate: boolean | null = null
  const values = head.values
  const companyId = jsonString(values.company)
  if (companyId) {
    const m = (yield* serverQuery(() =>
      db
        .select({ stages: mandate.stages })
        .from(mandate)
        .where(eq(mandate.status, 'active')),
    )).at(0)
    if (m && m.stages.length > 0) {
      const comp = (yield* serverQuery(() =>
        db
          .select({ values: entity.values })
          .from(entity)
          .where(eq(entity.id, companyId)),
      )).at(0)
      const stage = comp ? jsonString(comp.values.funding_stage) : null
      if (stage !== null) outsideMandate = !m.stages.includes(stage)
    }
  }

  // The spaces this deal is filed in, for its details column.
  const spaces = yield* serverQuery(() => recordSpaces(id))

  const { dealReadoutsProgram } = yield* Effect.promise(
    () => import('../records/readouts'),
  )
  const readouts = yield* dealReadoutsProgram(id, new Date())
  // Company, People and every other relationship, both halves.
  const { recordRelationsProgram, relationNames } = yield* Effect.promise(
    () => import('@spaces/core/writes/read/relations'),
  )
  const relations = yield* recordRelationsProgram(id)

  return {
    id: head.id,
    name: head.name,
    mergedIntoId: head.mergedIntoId,
    values,
    createdAt: head.createdAt.toISOString(),
    outsideMandate,
    readouts,
    spaces,
    relations,
    refNames: {
      ...relationNames(relations),
      ...Object.fromEntries(
        refs.map((r) => [r.toId, { name: r.name, kind: r.kind }]),
      ),
    },
    userNames: Object.fromEntries(users.map((u) => [u.id, u.name])),
  }
})

export const getDeal = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(getDealProgram(data.id))
  })

/** Funnel stats for Today and the deals list — `stageFunnelProgram`. */
export const dealFunnelStats = createServerFn().handler(async () => {
  await requireUser()
  const { stageFunnelProgram } = await import('../deals/funnel')
  const { effectFn } = await import('./effect')
  return effectFn(stageFunnelProgram)(Date.now())
})
