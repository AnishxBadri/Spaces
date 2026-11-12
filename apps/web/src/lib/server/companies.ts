import { createServerFn } from '@tanstack/react-start'
import { Cause, Effect, Schema } from 'effect'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
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
import type { Condition } from '@spaces/core/views/filter'
import type { ListPageOptions } from '#/lib/views/paging'
import { recordSpaces } from '#/lib/spaces/filed-in'
import { input } from './input'
import { serverQuery } from './query'

const uuid = Schema.String.check(Schema.isUUID())

class CompanyNotFound extends Schema.TaggedError<CompanyNotFound>()(
  'CompanyNotFound',
  { message: Schema.String },
) {}

/** Add to space refused, with the reason the list's toast shows. */
class AddToSpaceRefused extends Schema.TaggedError<AddToSpaceRefused>()(
  'AddToSpaceRefused',
  { message: Schema.String },
) {}

const listCompaniesProgram = Effect.fn('listCompaniesProgram')(function* () {
  const rows = yield* serverQuery(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        sourceClass: entity.sourceClass,
        createdAt: entity.createdAt,
      })
      .from(entity)
      .where(
        and(
          eq(entity.kind, 'company'),
          isNull(entity.mergedIntoId),
          isNull(entity.archivedAt),
        ),
      )
      .orderBy(desc(entity.createdAt)),
  )

  if (rows.length === 0) return []

  // Primary domain per company, one query.
  const domains = yield* serverQuery(() =>
    db
      .select({
        entityId: entityAlias.entityId,
        domain: entityAlias.valueNorm,
      })
      .from(entityAlias)
      .where(
        and(eq(entityAlias.kind, 'domain'), eq(entityAlias.isIdentity, true)),
      ),
  )
  const domainByEntity = new Map(domains.map((d) => [d.entityId, d.domain]))

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    domain: domainByEntity.get(r.id) ?? null,
  }))
})

export const listCompanies = createServerFn().handler(async () => {
  await requireUser()
  return Effect.runPromise(listCompaniesProgram())
})

const createCompanyInput = Schema.Struct({
  name: Schema.optional(Schema.Trim.check(Schema.isMaxLength(160))),
  domain: Schema.optional(Schema.Trim.check(Schema.isMaxLength(255))),
  /** attribute values set in the create dialog — win over defaults */
  values: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).check(
  Schema.makeFilter((v) => Boolean(v.name || v.domain), {
    message: 'Give a name or a domain',
  }),
)

const createCompanyProgram = Effect.fn('createCompanyProgram')(function* (
  data: typeof createCompanyInput.Type,
  actorId: string,
) {
  // Resolve, embed and emit fail as they always have: their messages are
  // what the create dialog shows.
  const { reembed, emit, ...result } = yield* Effect.promise(() =>
    resolveEntity({
      kind: 'company',
      ...(data.name ? { name: data.name } : {}),
      ...(data.domain ? { keys: { domain: data.domain } } : {}),
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

  if (result.action === 'created') {
    yield* serverQuery(() =>
      db.insert(activity).values({
        actorId,
        verb: 'company.created',
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

export const createCompany = createServerFn({ method: 'POST' })
  .validator(input(createCompanyInput))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(createCompanyProgram(data, u.id))
  })

const listCompaniesTableProgram = Effect.fn('listCompaniesTableProgram')(
  function* (conditions: Array<Condition>, options: ListPageOptions) {
    const { listCompaniesPageProgram } = yield* Effect.promise(
      () => import('../views/directory'),
    )
    const { withPictures } = yield* Effect.promise(
      () => import('../records/pictures'),
    )
    const page = yield* listCompaniesPageProgram(conditions, options)
    // A storage failure reaches the caller as the storage threw it.
    return {
      ...page,
      rows: yield* Effect.promise(() => withPictures(page.rows)),
    }
  },
)

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
  .validator(input(pagedListInput))
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(
      listCompaniesTableProgram(data.conditions ?? [], pageOptions(data)),
    )
  })

const getCompanyProgram = Effect.fn('getCompanyProgram')(function* (
  id: string,
) {
  const head = (yield* serverQuery(() =>
    db
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
      .where(eq(entity.id, id)),
  )).at(0)
  if (!head) return yield* new CompanyNotFound({ message: 'Company not found' })

  const aliases = yield* serverQuery(() =>
    db
      .select({
        id: entityAlias.id,
        kind: entityAlias.kind,
        value: entityAlias.value,
        valueNorm: entityAlias.valueNorm,
        isIdentity: entityAlias.isIdentity,
        sourceClass: entityAlias.sourceClass,
      })
      .from(entityAlias)
      .where(eq(entityAlias.entityId, id)),
  )

  const spaces = yield* serverQuery(() => recordSpaces(id))

  // Team, Associated deals and every other relationship, both halves,
  // through the one resolver.
  const { recordRelationsProgram, relationNames } = yield* Effect.promise(
    () => import('@spaces/core/writes/read/relations'),
  )
  const relations = yield* recordRelationsProgram(id)
  // The stage chip on each associated deal.
  const dealIds =
    relations
      .find((h) => h.derived && h.slug === 'associated_deals')
      ?.items.map((i) => i.id) ?? []
  const dealStages = Object.fromEntries(
    dealIds.length === 0
      ? []
      : (yield* serverQuery(() =>
          db
            .select({ id: entity.id, values: entity.values })
            .from(entity)
            .where(inArray(entity.id, dealIds)),
        )).map((d) => [d.id, jsonString(d.values.stage)]),
  )
  // The role on each Team row: the person's job title.
  const teamIds =
    relations
      .find((h) => h.derived && h.slug === 'team')
      ?.items.map((i) => i.id) ?? []
  const teamRoles: Record<string, string> = Object.fromEntries(
    teamIds.length === 0
      ? []
      : (yield* serverQuery(() =>
          db
            .select({ id: entity.id, values: entity.values })
            .from(entity)
            .where(inArray(entity.id, teamIds)),
        )).flatMap((p) => {
          const role = jsonString(p.values.job_title)
          return role === null || role === '' ? [] : [[p.id, role]]
        }),
  )
  // Names for this company's own reference values (`founders`).
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
  const refNames = {
    ...Object.fromEntries(referenced.map((r) => [r.id, { name: r.name }])),
    ...relationNames(relations),
  }
  const { companyReadoutsProgram } = yield* Effect.promise(
    () => import('../records/readouts'),
  )
  const readouts = yield* companyReadoutsProgram(id, new Date())

  const timeline = yield* serverQuery(() =>
    db
      .select({
        id: activity.id,
        verb: activity.verb,
        actorId: activity.actorId,
        at: activity.at,
      })
      .from(activity)
      .where(eq(activity.subjectEntityId, id))
      .orderBy(desc(activity.at))
      .limit(50),
  )

  const { pictureUrl } = yield* Effect.promise(
    () => import('../records/pictures'),
  )
  // A storage failure reaches the caller as the storage threw it.
  const picture = yield* Effect.promise(() => pictureUrl(head.pictureSha))
  return {
    id: head.id,
    name: head.name,
    sourceClass: head.sourceClass,
    mergedIntoId: head.mergedIntoId,
    createdAt: head.createdAt.toISOString(),
    values: head.values,
    picture,
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

export const getCompany = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(getCompanyProgram(data.id))
  })

const updateRecordProgram = Effect.fn('updateRecordProgram')(function* (
  data: {
    readonly id: string
    readonly name?: string | undefined
    readonly patch?: { readonly [slug: string]: unknown } | undefined
  },
  actorId: string,
) {
  // Empty until the patch half runs: a rename asserts no identity key, so
  // a name-only update truthfully reports no outcomes rather than none.
  let identity: SetValuesResult['identity'] = {}
  let identityValues: SetValuesResult['identityValues'] = {}
  if (data.name) {
    const { renameRecordProgram } = yield* Effect.promise(
      () => import('@spaces/core/writes/entities/rename'),
    )
    yield* renameRecordProgram(actorId, { id: data.id, name: data.name })
  }
  const patch = data.patch
  if (patch && Object.keys(patch).length > 0) {
    const { setValuesEffect } = yield* Effect.promise(
      () => import('@spaces/core/writes/attributes/values'),
    )
    // The identity outcome is the only thing this call returns that the
    // client cannot recompute: the claim was decided inside the write's
    // transaction. Threaded out so the editing surfaces can say so.
    const result = yield* setValuesEffect({
      entityId: data.id,
      patch,
      actor: { type: 'user', id: actorId },
    })
    identity = result.identity
    identityValues = result.identityValues
    // After the commit: the embeddable values this write set, queued here
    // because core hands them back rather than reaching the queue. These
    // fail as they always have.
    for (const s of result.reembed)
      yield* Effect.promise(() => enqueueSourceEmbed(s))
    // A company or person this write made a deal's party.
    for (const party of result.dealParties)
      yield* Effect.promise(() => emitDomainEvent(dealLinked(party, 'manual')))
    // A domain or email the record gained: auto-enrich may run now.
    for (const added of result.identityAdded)
      yield* Effect.promise(() => emitDomainEvent(added))
    // The pipeline→portfolio seam: a deal reaching Invested births a
    // holding (idempotent — follow-ons land on the existing one).
    if (patch.stage === 'invested') {
      const row = (yield* serverQuery(() =>
        db
          .select({ kind: entity.kind, values: entity.values })
          .from(entity)
          .where(eq(entity.id, data.id)),
      )).at(0)
      const companyId = row ? jsonString(row.values.company) : null
      if (row?.kind === 'deal' && companyId !== null) {
        const { birthHolding } = yield* Effect.promise(() => import('./shared'))
        yield* Effect.promise(() => birthHolding({ companyId, actorId }))
      }
    }
  }
  return { ok: true, identity, identityValues }
})

/**
 * Generic record update for object-model entities: rename and/or an
 * attribute-values patch through the one validated write path.
 */
export const updateRecord = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: uuid,
        name: Schema.optional(
          Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        ),
        patch: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(updateRecordProgram(data, u.id))
  })

const spaceTagInput = input(Schema.Struct({ entityId: uuid, spaceId: uuid }))

export const tagIntoSpace = createServerFn({ method: 'POST' })
  .validator(spaceTagInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(tagIntoSpaceProgram({ ...data, actorId: u.id }))
  })

const tagIntoSpaceProgram = Effect.fn('tagIntoSpaceProgram')(
  function* (filing: { entityId: string; spaceId: string; actorId: string }) {
    // The hand tag, shared with Move here; its insert is `insertSpaceTag`.
    const { tagByHand } = yield* Effect.promise(() => import('../spaces/tag'))
    const { emit } = yield* serverQuery(() =>
      db.transaction((tx) => tagByHand(tx, filing)),
    )
    yield* Effect.promise(() => emitDomainEvent(emit))
    return { ok: true }
  },
)

export const untagFromSpace = createServerFn({ method: 'POST' })
  .validator(spaceTagInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(untagFromSpaceProgram({ ...data, actorId: u.id }))
  })

const untagFromSpaceProgram = Effect.fn('untagFromSpaceProgram')(
  function* (filing: { entityId: string; spaceId: string; actorId: string }) {
    const { restampUntagged, untagByHand } = yield* Effect.promise(
      () => import('../spaces/tag'),
    )
    yield* serverQuery(() => db.transaction((tx) => untagByHand(tx, filing)))
    yield* Effect.promise(() =>
      restampUntagged(filing.entityId, filing.spaceId),
    )
    return { ok: true }
  },
)

const tagManyIntoSpaceProgram = Effect.fn('tagManyIntoSpaceProgram')(function* (
  actorId: string,
  data: { spaceId: string; entityIds: ReadonlyArray<string> },
) {
  const { tagManyMessage, tagManyProgram } = yield* Effect.promise(
    () => import('../spaces/tag-many'),
  )
  // Whatever stopped the batch reaches the toast as `tagManyMessage` reads it.
  const result = yield* tagManyProgram(actorId, data).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new AddToSpaceRefused({
          message: tagManyMessage(Cause.squash(cause)),
        }),
      ),
    ),
  )
  for (const emit of result.emits)
    yield* Effect.promise(() => emitDomainEvent(emit))
  return { tagged: result.tagged }
})

/**
 * Add to space from a list's selection: one transaction over the hand tag.
 * `tagged` names only the records this call filed — Undo untags those.
 */
export const tagManyIntoSpace = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        spaceId: uuid,
        entityIds: Schema.Array(uuid).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(1000),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(tagManyIntoSpaceProgram(u.id, data))
  })
