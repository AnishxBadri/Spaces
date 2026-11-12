import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, link, person } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  groupReferencedBy,
  referencedByRowsProgram,
  requireUser,
  withoutRelations,
} from './shared'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import { emitDomainEvent } from '#/lib/events/emit'
import { pagedListInput, pageOptions } from '#/lib/views/page-input'
import { recordSpaces } from '#/lib/spaces/filed-in'
import type { Condition } from '@spaces/core/views/filter'
import type { ListPageOptions } from '#/lib/views/paging'
import { input } from './input'
import { serverQuery } from './query'

const uuid = Schema.String.check(Schema.isUUID())

class PersonNotFound extends Schema.TaggedError<PersonNotFound>()(
  'PersonNotFound',
  { message: Schema.String },
) {}

const listPeopleTableProgram = Effect.fn('listPeopleTableProgram')(function* (
  conditions: Array<Condition>,
  options: ListPageOptions,
) {
  const { listPeoplePageProgram } = yield* Effect.promise(
    () => import('../views/directory'),
  )
  const { withPictures } = yield* Effect.promise(
    () => import('../records/pictures'),
  )
  const page = yield* listPeoplePageProgram(conditions, options)
  // A storage failure reaches the caller as the storage threw it.
  return { ...page, rows: yield* Effect.promise(() => withPictures(page.rows)) }
})

/**
 * The `/people` table, paged like every list: values, identity emails and the
 * names its reference cells show, read over the page's ids.
 *
 * `listPeoplePageProgram` lives outside the server-fn modules because this
 * module is re-exported by the client-imported barrel.
 */
export const listPeopleTable = createServerFn()
  .validator(pagedListInput)
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(
      listPeopleTableProgram(data.conditions ?? [], pageOptions(data)),
    )
  })

const createPersonInput = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  email: Schema.optional(Schema.Trim.check(Schema.isMaxLength(255))),
  companyId: Schema.optional(uuid),
  /** attribute values set in the create dialog — win over defaults */
  values: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const createPersonProgram = Effect.fn('createPersonProgram')(function* (
  data: typeof createPersonInput.Type,
  actorId: string,
) {
  // Resolve, embed and emit fail as they always have: their messages are
  // what the create dialog shows.
  const { reembed, emit, ...result } = yield* Effect.promise(() =>
    resolveEntity({
      kind: 'person',
      name: data.name,
      keys: data.email ? { email: data.email } : undefined,
      source: { class: 'manual' },
      createdBy: actorId,
      values: data.values,
    }),
  )
  // The birth's embeddable values, queued once the resolve has returned —
  // core hands them back rather than reaching the queue.
  for (const s of reembed) yield* Effect.promise(() => enqueueSourceEmbed(s))
  // A manual birth's `entity.created`; null on an attach.
  yield* Effect.promise(() => emitDomainEvent(emit))
  // The picked company joins the person's `companies` through the one
  // write path — on an attach too, where birth values are not written.
  const companyId = data.companyId
  if (companyId) {
    const { setPersonCompanyProgram } = yield* Effect.promise(
      () => import('../people/companies'),
    )
    yield* setPersonCompanyProgram({
      personId: result.entityId,
      companyId,
      action: 'link',
      actor: { type: 'user', id: actorId },
    })
  }
  if (result.action === 'created') {
    yield* serverQuery(() =>
      db.insert(activity).values({
        actorId,
        verb: 'person.created',
        subjectEntityId: result.entityId,
      }),
    )
  }
  const [row] = yield* serverQuery(() =>
    db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, result.entityId)),
  )
  return { ...result, name: row.name }
})

export const createPerson = createServerFn({ method: 'POST' })
  .validator(input(createPersonInput))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(createPersonProgram(data, u.id))
  })

const getPersonProgram = Effect.fn('getPersonProgram')(function* (id: string) {
  const head = (yield* serverQuery(() =>
    db
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
      .where(eq(entity.id, id)),
  )).at(0)
  if (!head) return yield* new PersonNotFound({ message: 'Person not found' })

  // Names for this person's reference values, `companies` among them, so
  // the rail's cells and the Companies list can print them.
  const referenced = yield* serverQuery(() =>
    db
      .select({ id: entity.id, name: entity.canonicalName })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .where(
        and(
          eq(link.fromEntityId, id),
          eq(link.relation, 'references'),
          isNull(entity.mergedIntoId),
        ),
      ),
  )
  // Companies, Deals and every other relationship, both halves.
  const { recordRelationsProgram, relationNames } = yield* Effect.promise(
    () => import('@spaces/core/writes/read/relations'),
  )
  const relations = yield* recordRelationsProgram(id)
  const refNames = {
    ...Object.fromEntries(referenced.map((r) => [r.id, { name: r.name }])),
    ...relationNames(relations),
  }

  // Spaces this person is tagged into, which fills the space page's
  // Contacts lane. Same query as `getCompany`'s, same two server fns on
  // the rail.
  const spaces = yield* serverQuery(() => recordSpaces(id))

  // Inbound record-references, grouped by the attribute that made them:
  // `deal.referred_by` is one, and any later attribute
  // pointing at a person joins it with no edit to the page.
  // A relationship's owner links read as its inverse half instead.
  const referencedBy = groupReferencedBy(
    withoutRelations(yield* referencedByRowsProgram(id), relations),
  )

  const timeline = yield* serverQuery(() =>
    db
      .select({
        id: activity.id,
        verb: activity.verb,
        at: activity.at,
      })
      .from(activity)
      .where(eq(activity.subjectEntityId, id))
      .orderBy(desc(activity.at))
      .limit(50),
  )

  const { personReadoutsProgram } = yield* Effect.promise(
    () => import('../records/readouts'),
  )
  const readouts = yield* personReadoutsProgram(id, new Date())

  const { pictureUrl } = yield* Effect.promise(
    () => import('../records/pictures'),
  )
  // A storage failure reaches the caller as the storage threw it.
  const picture = yield* Effect.promise(() => pictureUrl(head.pictureSha))
  return {
    id: head.id,
    name: head.name,
    mergedIntoId: head.mergedIntoId,
    createdAt: head.createdAt.toISOString(),
    values: head.values,
    picture,
    readouts,
    relations,
    refNames,
    spaces,
    referencedBy,
    timeline: timeline.map((t) => ({ ...t, at: t.at.toISOString() })),
  }
})

export const getPerson = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(getPersonProgram(data.id))
  })

export const setPersonCompany = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        personId: uuid,
        companyId: uuid,
        action: Schema.Literals(['link', 'unlink']),
      }),
    ),
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
