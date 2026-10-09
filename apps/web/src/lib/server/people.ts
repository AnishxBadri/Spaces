import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { entity, entityAlias, link, person } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { jsonString } from '@spaces/core/json'
import { groupReferencedBy, referencedByRows, requireUser } from './shared'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import { emitDomainEvent } from '#/lib/events/emit'
import { pagedListInput, pageOptions } from '#/lib/views/page-input'
import { recordSpaces } from '#/lib/spaces/filed-in'

export const listPeople = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      values: entity.values,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .innerJoin(person, eq(person.entityId, entity.id))
    .where(isNull(entity.mergedIntoId))
    .orderBy(desc(entity.createdAt))
  if (rows.length === 0) return []

  // Primary email + companies per person, batched.
  const emails = await db
    .select({ entityId: entityAlias.entityId, email: entityAlias.valueNorm })
    .from(entityAlias)
    .where(and(eq(entityAlias.kind, 'email'), eq(entityAlias.isIdentity, true)))
  const emailBy = new Map(emails.map((e) => [e.entityId, e.email]))

  // Names for every `companies` value; the value decides which and in what order.
  const { companyIdsOf, personCompanyEdge } =
    await import('../people/companies')
  const named = await db
    .select({ id: entity.id, name: entity.canonicalName })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(and(personCompanyEdge, isNull(entity.mergedIntoId)))
  const nameBy = new Map(named.map((c) => [c.id, c.name]))

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    headline: jsonString(r.values.job_title),
    email: emailBy.get(r.id) ?? null,
    companies: companyIdsOf(r.values).flatMap((id) => {
      const name = nameBy.get(id)
      return name === undefined ? [] : [{ id, name }]
    }),
    createdAt: r.createdAt.toISOString(),
  }))
})

/**
 * The `/people` table, on views-3's paging contract: values, identity emails
 * and the names its reference cells show, read over the page's ids.
 *
 * The read is `listPeoplePageProgram` in `lib/views/directory.ts`, outside
 * `lib/server/` because this module is re-exported by the client-imported
 * barrel.
 */
export const listPeopleTable = createServerFn()
  .validator(pagedListInput)
  .handler(async ({ data }) => {
    await requireUser()
    const { listPeoplePageProgram } = await import('../views/directory')
    const { effectFn } = await import('./effect')
    const { withPictures } = await import('../records/pictures')
    const page = await effectFn(listPeoplePageProgram)(
      data.conditions ?? [],
      pageOptions(data),
    )
    return { ...page, rows: await withPictures(page.rows) }
  })

const createPersonInput = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().max(255).optional(),
  companyId: z.string().uuid().optional(),
  /** attribute values set in the create dialog — win over defaults */
  values: z.record(z.string(), z.unknown()).optional(),
})

export const createPerson = createServerFn({ method: 'POST' })
  .validator(createPersonInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { reembed, emit, ...result } = await resolveEntity({
      kind: 'person',
      name: data.name,
      keys: data.email ? { email: data.email } : undefined,
      source: { class: 'manual' },
      createdBy: u.id,
      values: data.values,
    })
    // The birth's embeddable values, queued once the resolve has returned —
    // core hands them back rather than reaching the queue (SPA-174/175).
    for (const s of reembed) await enqueueSourceEmbed(s)
    // A manual birth's `entity.created`; null on an attach. (D65)
    await emitDomainEvent(emit)
    // The picked company joins the person's `companies` through the one
    // write path — on an attach too, where birth values are not written.
    if (data.companyId) {
      const { setPersonCompanyProgram } = await import('../people/companies')
      const { effectFn } = await import('./effect')
      await effectFn(setPersonCompanyProgram)({
        personId: result.entityId,
        companyId: data.companyId,
        action: 'link',
        actor: { type: 'user', id: u.id },
      })
    }
    if (result.action === 'created') {
      await db.insert(activity).values({
        actorId: u.id,
        verb: 'person.created',
        subjectEntityId: result.entityId,
      })
    }
    const [row] = await db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, result.entityId))
    return { ...result, name: row.name }
  })

export const getPerson = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const head = (
      await db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          mergedIntoId: entity.mergedIntoId,
          createdAt: entity.createdAt,
          values: entity.values,
          pictureSha: entity.pictureSha,
        })
        .from(entity)
        .innerJoin(person, eq(person.entityId, entity.id))
        .where(eq(entity.id, data.id))
    ).at(0)
    if (!head) throw new Error('Person not found')

    // Names for this person's reference values, `companies` among them, so
    // the rail's cells and the Companies list can print them.
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
    const nameBy = new Map(referenced.map((r) => [r.id, r.name]))
    const refNames = Object.fromEntries(
      referenced.map((r) => [r.id, { name: r.name }]),
    )
    const { companyIdsOf } = await import('../people/companies')
    const companies = companyIdsOf(head.values).flatMap((id) => {
      const name = nameBy.get(id)
      return name === undefined ? [] : [{ id, name }]
    })

    // Spaces this person is tagged into (SPA-99). `entity_space` always
    // accepted any kind, but until this slice only the company and custom
    // record pages had a rail to write one — so the space page's Contacts
    // section had no writer and its direct lane could never fill. Same
    // query as `getCompany`'s, same two server fns on the rail.
    const spaces = await recordSpaces(data.id)

    // Inbound record-references, grouped by the attribute that made them:
    // `deal.referred_by` (SPA-59) is the first, and any later attribute
    // pointing at a person joins it with no edit to the page.
    const referencedBy = groupReferencedBy(await referencedByRows(data.id))

    const timeline = await db
      .select({
        id: activity.id,
        verb: activity.verb,
        at: activity.at,
      })
      .from(activity)
      .where(eq(activity.subjectEntityId, data.id))
      .orderBy(desc(activity.at))
      .limit(50)

    const { personReadoutsProgram } = await import('../records/readouts')
    const { effectFn } = await import('./effect')
    const readouts = await effectFn(personReadoutsProgram)(data.id, new Date())

    const { pictureUrl } = await import('../records/pictures')
    return {
      id: head.id,
      name: head.name,
      mergedIntoId: head.mergedIntoId,
      values: head.values,
      picture: await pictureUrl(head.pictureSha),
      readouts,
      companies,
      refNames,
      spaces,
      referencedBy,
      timeline: timeline.map((t) => ({ ...t, at: t.at.toISOString() })),
    }
  })

export const setPersonCompany = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      personId: z.string().uuid(),
      companyId: z.string().uuid(),
      action: z.enum(['link', 'unlink']),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    // One company on or off the person's `companies`, through the one write
    // path: an `attribute_event` and the `references` link it materializes.
    const { setPersonCompanyProgram } = await import('../people/companies')
    const { effectFn } = await import('./effect')
    await effectFn(setPersonCompanyProgram)({
      personId: data.personId,
      companyId: data.companyId,
      action: data.action,
      actor: { type: 'user', id: u.id },
    })
    return { ok: true }
  })
