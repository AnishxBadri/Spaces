import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { entity, link } from '@spaces/db/schema'
import { mandate } from '@spaces/db/schema/workspace'
import { jsonString } from '@spaces/core/json'
import type { EntityValues } from '@spaces/db/schema/entities'
import type { RowStats } from '#/lib/views/stat-fields'
import { requireUser } from './shared'
import { recordSpaces } from '#/lib/spaces/filed-in'

const createDealInput = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  stage: z.string().max(60).optional(),
  value: z.number().finite().optional(),
  source: z.string().max(60).optional(),
})

/**
 * A deal from the create dialog. The birth (entity, values, activity, and the
 * Invested → holding seam) is `birthDealProgram`, the same program an
 * imported Deals row goes through; this is its thin caller.
 */
export const createDeal = createServerFn({ method: 'POST' })
  .validator(createDealInput)
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
export const listDealsTable = createServerFn().handler(async () => {
  await requireUser()
  // The same set the view chips count over.
  const { listScope } = await import('../views/scope')
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      values: entity.values,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .where(listScope({ kind: 'deal' }))
    .orderBy(desc(entity.createdAt))

  if (rows.length === 0) {
    const empty: Array<DealTableRow> = []
    const none: Record<string, string> = {}
    return { rows: empty, refNames: {}, userNames: {}, pictures: none }
  }
  const dealIds = rows.map((r) => r.id)
  const refs = await db
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
      and(eq(link.relation, 'references'), inArray(link.fromEntityId, dealIds)),
    )
  const refNames = new Map<string, { id: string; name: string; kind: string }>()
  for (const r of refs)
    refNames.set(r.toId, { id: r.toId, name: r.name, kind: r.kind })

  const users = await db.select({ id: user.id, name: user.name }).from(user)
  const { statsFor } = await import('../views/directory')
  const stats = await statsFor(dealIds)
  // The board card draws its company's picture in place of the mark.
  const { pictureUrlsFor } = await import('../records/pictures')
  const pictures = await pictureUrlsFor(
    [...refNames.values()].filter((r) => r.kind === 'company').map((r) => r.id),
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

export const getDeal = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const head = (
      await db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          kind: entity.kind,
          mergedIntoId: entity.mergedIntoId,
          values: entity.values,
          createdAt: entity.createdAt,
        })
        .from(entity)
        .where(and(eq(entity.id, data.id), eq(entity.kind, 'deal')))
    ).at(0)
    if (!head) throw new Error('Deal not found')

    // Resolve referenced entities + users for display.
    const refs = await db
      .select({
        toId: link.toEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .where(
        and(eq(link.fromEntityId, data.id), eq(link.relation, 'references')),
      )
    const users = await db.select({ id: user.id, name: user.name }).from(user)

    // Outside-mandate hint: rendered on the deal
    // record only — where the invest/pass judgment happens. A hint, never a
    // block; null when there is no mandate, no stages, or no company stage.
    let outsideMandate: boolean | null = null
    const values = head.values
    const companyId = jsonString(values.company)
    if (companyId) {
      const m = (
        await db
          .select({ stages: mandate.stages })
          .from(mandate)
          .where(eq(mandate.status, 'active'))
      ).at(0)
      if (m && m.stages.length > 0) {
        const comp = (
          await db
            .select({ values: entity.values })
            .from(entity)
            .where(eq(entity.id, companyId))
        ).at(0)
        const stage = comp ? jsonString(comp.values.funding_stage) : null
        if (stage !== null) outsideMandate = !m.stages.includes(stage)
      }
    }

    // The spaces this deal is filed in, for its details column.
    const spaces = await recordSpaces(data.id)

    const { dealReadoutsProgram } = await import('../records/readouts')
    const { effectFn } = await import('./effect')
    const readouts = await effectFn(dealReadoutsProgram)(data.id, new Date())
    // Company, People and every other relationship, both halves.
    const { recordRelationsProgram, relationNames } =
      await import('@spaces/core/writes/read/relations')
    const relations = await effectFn(recordRelationsProgram)(data.id)

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

/** Funnel stats for Today and the deals list — `stageFunnelProgram`. */
export const dealFunnelStats = createServerFn().handler(async () => {
  await requireUser()
  const { stageFunnelProgram } = await import('../deals/funnel')
  const { effectFn } = await import('./effect')
  return effectFn(stageFunnelProgram)(Date.now())
})
