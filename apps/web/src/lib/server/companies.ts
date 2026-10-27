import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { company, entity, entityAlias, link } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { jsonString } from '@spaces/core/json'
import { requireUser } from './shared'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import { emitDomainEvent } from '#/lib/events/emit'
import { dealLinked } from '@spaces/core/writes/events/dispatch'
import { pagedListInput, pageOptions } from '#/lib/views/page-input'
import type { SetValuesResult } from '@spaces/core/writes/attributes/values'
import { recordSpaces } from '#/lib/spaces/filed-in'

export const listCompanies = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      sourceClass: entity.sourceClass,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .where(and(eq(entity.kind, 'company'), isNull(entity.mergedIntoId)))
    .orderBy(desc(entity.createdAt))

  if (rows.length === 0) return []

  // Primary domain per company, one query.
  const domains = await db
    .select({
      entityId: entityAlias.entityId,
      domain: entityAlias.valueNorm,
    })
    .from(entityAlias)
    .where(
      and(eq(entityAlias.kind, 'domain'), eq(entityAlias.isIdentity, true)),
    )
  const domainByEntity = new Map(domains.map((d) => [d.entityId, d.domain]))

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    domain: domainByEntity.get(r.id) ?? null,
  }))
})

const createCompanyInput = z
  .object({
    name: z.string().trim().max(160).optional(),
    domain: z.string().trim().max(255).optional(),
    /** attribute values set in the create dialog — win over defaults */
    values: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.name || v.domain, {
    message: 'Give a name or a domain',
  })

export const createCompany = createServerFn({ method: 'POST' })
  .validator(createCompanyInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { reembed, emit, ...result } = await resolveEntity({
      kind: 'company',
      ...(data.name ? { name: data.name } : {}),
      ...(data.domain ? { keys: { domain: data.domain } } : {}),
      source: { class: 'manual' },
      createdBy: u.id,
      values: data.values,
    })
    // The birth's embeddable values, queued once the resolve has returned —
    // core hands them back rather than reaching the queue.
    for (const s of reembed) await enqueueSourceEmbed(s)
    // A manual birth's `entity.created`; null on an attach.
    await emitDomainEvent(emit)

    if (result.action === 'created') {
      await db.insert(activity).values({
        actorId: u.id,
        verb: 'company.created',
        subjectEntityId: result.entityId,
      })
    }

    const [row] = await db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, result.entityId))
    return { ...result, name: row.name }
  })

/**
 * The `/companies` table, paged like every list: takes
 * `{conditions, cursor, limit, sort, q}` and answers `{rows, nextCursor, total}`
 * with the keyset cursor and server count `/o/$objectSlug` uses. Side queries
 * run over the page's ids only, never the whole table.
 *
 * `listCompaniesPageProgram` is imported inside the handler: this module is
 * re-exported by the client-imported barrel, and a test can call it directly.
 */
export const listCompaniesTable = createServerFn()
  .validator(pagedListInput)
  .handler(async ({ data }) => {
    await requireUser()
    const { listCompaniesPageProgram } = await import('../views/directory')
    const { effectFn } = await import('./effect')
    const { withPictures } = await import('../records/pictures')
    const page = await effectFn(listCompaniesPageProgram)(
      data.conditions ?? [],
      pageOptions(data),
    )
    return { ...page, rows: await withPictures(page.rows) }
  })

export const getCompany = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()

    const head = (
      await db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          sourceClass: entity.sourceClass,
          mergedIntoId: entity.mergedIntoId,
          createdAt: entity.createdAt,
          values: entity.values,
          pictureSha: entity.pictureSha,
        })
        .from(entity)
        .innerJoin(company, eq(company.entityId, entity.id))
        .where(eq(entity.id, data.id))
    ).at(0)
    if (!head) throw new Error('Company not found')

    const aliases = await db
      .select({
        id: entityAlias.id,
        kind: entityAlias.kind,
        value: entityAlias.value,
        valueNorm: entityAlias.valueNorm,
        isIdentity: entityAlias.isIdentity,
        sourceClass: entityAlias.sourceClass,
      })
      .from(entityAlias)
      .where(eq(entityAlias.entityId, data.id))

    const spaces = await recordSpaces(data.id)

    // Team, Associated deals and every other relationship, both halves,
    // through the one resolver.
    const { effectFn } = await import('./effect')
    const { recordRelationsProgram, relationNames } =
      await import('@spaces/core/writes/read/relations')
    const relations = await effectFn(recordRelationsProgram)(data.id)
    // The stage chip on each associated deal.
    const dealIds =
      relations
        .find((h) => h.derived && h.slug === 'associated_deals')
        ?.items.map((i) => i.id) ?? []
    const dealStages = Object.fromEntries(
      dealIds.length === 0
        ? []
        : (
            await db
              .select({ id: entity.id, values: entity.values })
              .from(entity)
              .where(inArray(entity.id, dealIds))
          ).map((d) => [d.id, jsonString(d.values.stage)]),
    )
    // The role on each Team row: the person's job title.
    const teamIds =
      relations
        .find((h) => h.derived && h.slug === 'team')
        ?.items.map((i) => i.id) ?? []
    const teamRoles: Record<string, string> = Object.fromEntries(
      teamIds.length === 0
        ? []
        : (
            await db
              .select({ id: entity.id, values: entity.values })
              .from(entity)
              .where(inArray(entity.id, teamIds))
          ).flatMap((p) => {
            const role = jsonString(p.values.job_title)
            return role === null || role === '' ? [] : [[p.id, role]]
          }),
    )
    // Names for this company's own reference values (`founders`).
    const referenced = await db
      .select({ id: entity.id, name: entity.canonicalName })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .where(
        and(
          eq(link.fromEntityId, data.id),
          eq(link.relation, 'references'),
          isNull(entity.mergedIntoId),
        ),
      )
    const refNames = {
      ...Object.fromEntries(referenced.map((r) => [r.id, { name: r.name }])),
      ...relationNames(relations),
    }
    const { companyReadoutsProgram } = await import('../records/readouts')
    const readouts = await effectFn(companyReadoutsProgram)(data.id, new Date())

    const timeline = await db
      .select({
        id: activity.id,
        verb: activity.verb,
        actorId: activity.actorId,
        at: activity.at,
      })
      .from(activity)
      .where(eq(activity.subjectEntityId, data.id))
      .orderBy(desc(activity.at))
      .limit(50)

    const { pictureUrl } = await import('../records/pictures')
    return {
      id: head.id,
      name: head.name,
      sourceClass: head.sourceClass,
      mergedIntoId: head.mergedIntoId,
      createdAt: head.createdAt.toISOString(),
      values: head.values,
      picture: await pictureUrl(head.pictureSha),
      aliases,
      spaces,
      relations,
      dealStages,
      teamRoles,
      refNames,
      readouts,
      timeline: timeline.map((t) => ({ ...t, at: t.at.toISOString() })),
    }
  })

/**
 * Generic record update for object-model entities: rename and/or an
 * attribute-values patch through the one validated write path.
 */
export const updateRecord = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(200).optional(),
      patch: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    // Empty until the patch half runs: a rename asserts no identity key, so
    // a name-only update truthfully reports no outcomes rather than none.
    let identity: SetValuesResult['identity'] = {}
    let identityValues: SetValuesResult['identityValues'] = {}
    if (data.name) {
      const { effectFn } = await import('./effect')
      const { renameRecordProgram } =
        await import('@spaces/core/writes/entities/rename')
      await effectFn(renameRecordProgram)(u.id, {
        id: data.id,
        name: data.name,
      })
    }
    if (data.patch && Object.keys(data.patch).length > 0) {
      const { setValues } =
        await import('@spaces/core/writes/attributes/values')
      // The identity outcome is the only thing this call returns that the
      // client cannot recompute: the claim was decided inside the write's
      // transaction. Threaded out so the editing surfaces can say so.
      const result = await setValues({
        entityId: data.id,
        patch: data.patch,
        actor: { type: 'user', id: u.id },
      })
      identity = result.identity
      identityValues = result.identityValues
      // After the commit: the embeddable values this write set, queued here
      // because core hands them back rather than reaching the queue.
      for (const s of result.reembed) await enqueueSourceEmbed(s)
      // A company or person this write made a deal's party.
      for (const party of result.dealParties)
        await emitDomainEvent(dealLinked(party, 'manual'))
      // A domain or email the record gained: auto-enrich may run now.
      for (const added of result.identityAdded) await emitDomainEvent(added)
      // The pipeline→portfolio seam: a deal reaching Invested births a
      // holding (idempotent — follow-ons land on the existing one).
      if (data.patch.stage === 'invested') {
        const row = (
          await db
            .select({ kind: entity.kind, values: entity.values })
            .from(entity)
            .where(eq(entity.id, data.id))
        ).at(0)
        const companyId = row ? jsonString(row.values.company) : null
        if (row?.kind === 'deal' && companyId !== null) {
          const { birthHolding } = await import('./shared')
          await birthHolding({ companyId, actorId: u.id })
        }
      }
    }
    return { ok: true, identity, identityValues }
  })

export const tagIntoSpace = createServerFn({ method: 'POST' })
  .validator(
    z.object({ entityId: z.string().uuid(), spaceId: z.string().uuid() }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    // The hand tag, shared with Move here; its insert is `insertSpaceTag`.
    const { tagByHand } = await import('../spaces/tag')
    const { emit } = await db.transaction((tx) =>
      tagByHand(tx, { ...data, actorId: u.id }),
    )
    await emitDomainEvent(emit)
    return { ok: true }
  })

export const untagFromSpace = createServerFn({ method: 'POST' })
  .validator(
    z.object({ entityId: z.string().uuid(), spaceId: z.string().uuid() }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { restampUntagged, untagByHand } = await import('../spaces/tag')
    await db.transaction((tx) => untagByHand(tx, { ...data, actorId: u.id }))
    await restampUntagged(data.entityId, data.spaceId)
    return { ok: true }
  })

/**
 * Add to space from a list's selection: one transaction over the hand tag.
 * `tagged` names only the records this call filed — Undo untags those.
 */
export const tagManyIntoSpace = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      spaceId: z.string().uuid(),
      entityIds: z.array(z.string().uuid()).min(1).max(1000),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { tagManyMessage, tagManyProgram } =
      await import('../spaces/tag-many')
    const { effectFn } = await import('./effect')
    const result = await effectFn(tagManyProgram)(u.id, data).catch(
      (failure: unknown) => {
        throw new Error(tagManyMessage(failure))
      },
    )
    for (const emit of result.emits) await emitDomainEvent(emit)
    return { tagged: result.tagged }
  })
