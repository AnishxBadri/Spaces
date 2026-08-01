import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { user } from '#/db/schema/auth'
import { entity, link } from '#/db/schema'
import { mandate } from '#/db/schema/workspace'
import { activity } from '#/db/schema/activity'
import { requireUser } from './shared'
import type { Json } from './shared'

const createDealInput = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  stage: z.string().max(60).optional(),
  value: z.number().finite().optional(),
  source: z.string().max(60).optional(),
})

export const createDeal = createServerFn({ method: 'POST' })
  .validator(createDealInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const [ent] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: data.name, createdBy: u.id })
      .returning({ id: entity.id })

    const { setValues } = await import('../attributes/values')
    await setValues({
      entityId: ent.id,
      patch: {
        company: data.companyId,
        stage: data.stage ?? 'pre_lead',
        owner: u.id,
        ...(data.value !== undefined ? { value: data.value } : {}),
        ...(data.source ? { source: data.source } : {}),
      },
      actorId: u.id,
    })
    await db.insert(activity).values({
      actorId: u.id,
      verb: 'deal.created',
      subjectEntityId: data.companyId,
      objectEntityId: ent.id,
    })
    return { id: ent.id }
  })

/**
 * Deal rows with referenced records resolved for display: values hold
 * uuids; the table wants names. One pass over reference links.
 */
export const listDealsTable = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      values: entity.values,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .where(and(eq(entity.kind, 'deal'), isNull(entity.mergedIntoId)))
    .orderBy(desc(entity.createdAt))

  if (rows.length === 0)
    return {
      rows: [] as Array<{
        id: string
        name: string
        values: Record<string, Json>
        createdAt: string
      }>,
      refNames: {} as Record<
        string,
        { id: string; name: string; kind: string }
      >,
      userNames: {} as Record<string, string>,
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

  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      values: (r.values ?? {}) as Record<string, Json>,
      createdAt: r.createdAt.toISOString(),
    })),
    refNames: Object.fromEntries(refNames) as Record<
      string,
      { id: string; name: string; kind: string }
    >,
    userNames: Object.fromEntries(users.map((u) => [u.id, u.name])) as Record<
      string,
      string
    >,
  }
})

/** Deals referencing a company — the company record's Deals section. */
export const listCompanyDeals = createServerFn()
  .validator(z.object({ companyId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const rows = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, data.companyId),
          eq(link.relation, 'references'),
          eq(link.attrSlug, 'company'),
          eq(entity.kind, 'deal'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(desc(entity.createdAt))
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      stage: ((r.values ?? {}) as Record<string, unknown>).stage as
        string | undefined,
    }))
  })

export const getDeal = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const [head] = await db
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

    const mentionedIn = await db
      .select({
        fromId: link.fromEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(and(eq(link.toEntityId, data.id), eq(link.relation, 'mentions')))

    // Outside-mandate hint (CONTEXT.md, 2026-08): rendered on the deal
    // record only — where the invest/pass judgment happens. A hint, never a
    // block; null when there is no mandate, no stages, or no company stage.
    let outsideMandate: boolean | null = null
    const values = (head.values ?? {}) as Record<string, Json>
    const companyId = values.company as string | undefined
    if (companyId) {
      const [m] = await db
        .select({ stages: mandate.stages })
        .from(mandate)
        .where(eq(mandate.status, 'active'))
      if (m && m.stages.length > 0) {
        const [comp] = await db
          .select({ values: entity.values })
          .from(entity)
          .where(eq(entity.id, companyId))
        const stage = (comp?.values as Record<string, unknown> | null)
          ?.funding_stage as string | undefined
        if (stage) outsideMandate = !m.stages.includes(stage)
      }
    }

    return {
      id: head.id,
      name: head.name,
      mergedIntoId: head.mergedIntoId,
      values,
      createdAt: head.createdAt.toISOString(),
      outsideMandate,
      refNames: Object.fromEntries(
        refs.map((r) => [r.toId, { name: r.name, kind: r.kind }]),
      ) as Record<string, { name: string; kind: string }>,
      userNames: Object.fromEntries(users.map((u) => [u.id, u.name])) as Record<
        string,
        string
      >,
      mentionedIn,
    }
  })
