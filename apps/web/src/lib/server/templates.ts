import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, space, term } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { template } from '@spaces/db/schema/templates'
import { toObjectKind } from '@spaces/core/attributes/registry'
import { draftAttachmentsSchema } from '@spaces/core/json'
import { createSpaceRowProgram, requireUser } from './shared'
import type { Json, ParentSpaceNotFound } from './shared'
import { input } from './input'
import { serverQuery } from './query'
import type { ServerQueryFailed } from './query'

/**
 * Templates — standardized capture, never automation. All creation is
 * by-example: save an existing note/record/space as the pattern. Member-
 * writable like the rest of the content layer.
 */

// ---------- shared ----------

const KINDS = ['note', 'space', 'record', 'email'] as const

const uuid = Schema.String.check(Schema.isUUID())
const templateName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
)

/** What a template was asked to come from, or be stamped from, is gone. */
class TemplateSourceNotFound extends Schema.TaggedError<TemplateSourceNotFound>()(
  'TemplateSourceNotFound',
  { message: Schema.String },
) {}

const listTemplatesProgram = Effect.fn('listTemplatesProgram')(function* (
  filter:
    | {
        readonly kind?: (typeof KINDS)[number] | undefined
        readonly objectKind?: 'company' | 'person' | 'deal' | undefined
        readonly includeArchived?: boolean | undefined
      }
    | undefined,
) {
  const rows = yield* serverQuery(() =>
    db
      .select()
      .from(template)
      .where(
        and(
          filter?.kind ? eq(template.kind, filter.kind) : undefined,
          filter?.objectKind
            ? eq(template.objectKind, filter.objectKind)
            : undefined,
          filter?.includeArchived ? undefined : eq(template.archived, false),
        ),
      )
      .orderBy(asc(template.sortOrder), asc(template.name)),
  )
  return rows.map((t) => ({
    id: t.id,
    kind: t.kind,
    objectKind: t.objectKind,
    // The genre a note template stamps; null on every
    // space/record template and on note templates saved before the column.
    noteKind: t.noteKind,
    name: t.name,
    body: t.body,
    suggestOn: t.suggestOn,
    archived: t.archived,
  }))
})

export const listTemplates = createServerFn()
  .validator(
    input(
      Schema.UndefinedOr(
        Schema.Struct({
          kind: Schema.optional(Schema.Literals(KINDS)),
          objectKind: Schema.optional(
            Schema.Literals(['company', 'person', 'deal']),
          ),
          includeArchived: Schema.optional(Schema.Boolean),
        }),
      ),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(listTemplatesProgram(data))
  })

const updateTemplateProgram = Effect.fn('updateTemplateProgram')(
  function* (data: {
    readonly id: string
    readonly name?: string | undefined
    readonly archived?: boolean | undefined
    readonly suggestOn?: ReadonlyArray<string> | undefined
  }) {
    yield* serverQuery(() =>
      db
        .update(template)
        .set({
          ...(data.name ? { name: data.name } : {}),
          ...(data.archived !== undefined ? { archived: data.archived } : {}),
          ...(data.suggestOn !== undefined
            ? { suggestOn: [...data.suggestOn] }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(template.id, data.id)),
    )
    return { ok: true }
  },
)

export const updateTemplate = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: uuid,
        name: Schema.optional(templateName),
        archived: Schema.optional(Schema.Boolean),
        suggestOn: Schema.optional(
          Schema.Array(Schema.String.check(Schema.isMaxLength(30))).check(
            Schema.isMaxLength(10),
          ),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(updateTemplateProgram(data))
  })

// ---------- note templates ----------

const saveNoteAsTemplateProgram = Effect.fn('saveNoteAsTemplateProgram')(
  function* (actorId: string, data: { noteId: string; name: string }) {
    const { captureNoteTemplate } = yield* Effect.promise(
      () => import('../notes/templates'),
    )
    return yield* Effect.promise(() => captureNoteTemplate(actorId, data))
  },
)

/** Capture is `captureNoteTemplate`. */
export const saveNoteAsTemplate = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ noteId: uuid, name: templateName })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(saveNoteAsTemplateProgram(u.id, data))
  })

const createNoteFromTemplateProgram = Effect.fn(
  'createNoteFromTemplateProgram',
)(function* (actorId: string, data: { templateId: string }) {
  const { stampNoteTemplate } = yield* Effect.promise(
    () => import('../notes/templates'),
  )
  return yield* Effect.promise(() => stampNoteTemplate(actorId, data))
})

/** Stamp is `stampNoteTemplate`. */
export const createNoteFromTemplate = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ templateId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(createNoteFromTemplateProgram(u.id, data))
  })

// ---------- record templates ----------

/** Slug types that never belong in a template's defaults. */
const NON_TEMPLATABLE_TYPES = new Set(['record_reference', 'actor_reference'])

const saveRecordAsTemplateProgram = Effect.fn('saveRecordAsTemplateProgram')(
  function* (actorId: string, data: { recordId: string; name: string }) {
    const row = (yield* serverQuery(() =>
      db
        .select({ kind: entity.kind, values: entity.values })
        .from(entity)
        .where(and(eq(entity.id, data.recordId), isNull(entity.mergedIntoId))),
    )).at(0)
    if (!row || !['company', 'person', 'deal'].includes(row.kind)) {
      return yield* new TemplateSourceNotFound({ message: 'Record not found' })
    }
    const { getRegistry } = yield* Effect.promise(
      () => import('@spaces/core/writes/attributes/values'),
    )
    const core = toObjectKind(row.kind)
    if (!core)
      return yield* new TemplateSourceNotFound({ message: 'Record not found' })
    const registry = yield* Effect.promise(() => getRegistry(core))
    // Identity (a person's emails, a company's domains) belongs to one
    // record; a template carrying it would only mint duplicates.
    const templatable = new Map(
      registry
        .filter(
          (d) =>
            !NON_TEMPLATABLE_TYPES.has(d.type) &&
            !d.archived &&
            d.options.identityKey === undefined,
        )
        .map((d) => [d.slug, d]),
    )
    const values = Object.fromEntries(
      Object.entries(row.values).filter(
        ([slug, v]) => templatable.has(slug) && v !== null,
      ),
    )
    const [t] = yield* serverQuery(() =>
      db
        .insert(template)
        .values({
          kind: 'record',
          objectKind: row.kind,
          name: data.name,
          body: { values },
          suggestOn: [row.kind],
          createdBy: actorId,
        })
        .returning({ id: template.id }),
    )
    return { id: t.id }
  },
)

export const saveRecordAsTemplate = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ recordId: uuid, name: templateName })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(saveRecordAsTemplateProgram(u.id, data))
  })

// Record templates have no apply fn: the create modal fetches the body and
// PRE-FILLS its fields, visibly and editably. Nothing writes silently.

// ---------- email templates ----------

/** Save as template from the composer: its subject, body and files. */
export const saveEmailAsTemplate = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
        subject: Schema.String.check(Schema.isMaxLength(998)),
        bodyMd: Schema.String.check(Schema.isMaxLength(200_000)),
        attachments: draftAttachmentsSchema,
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { saveEmailTemplateProgram } =
      await import('../interactions/email-templates')
    const { effectFn } = await import('./effect')
    return effectFn(saveEmailTemplateProgram)({ id: u.id }, data)
  })

/** What applying a template copies into the open draft. */
export const getEmailTemplate = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { emailTemplateProgram, emailTemplateMessage } =
      await import('../interactions/email-templates')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(emailTemplateProgram)({ id: u.id }, data.id)
    } catch (failure) {
      throw new Error(emailTemplateMessage(failure))
    }
  })

// ---------- space templates ----------

type SpaceManifest = {
  terms: Array<{ name: string; definition: string }>
  children: Array<{ name: string } & SpaceManifest>
}

/** One stored space-template body, read back — a decode, not an assertion. */
function toSpaceManifest(body: Json): SpaceManifest {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { terms: [], children: [] }
  const named = (v: Json): string =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? String(v.name ?? '')
      : ''
  const terms = Array.isArray(body.terms)
    ? body.terms.flatMap((t) =>
        t !== null && typeof t === 'object' && !Array.isArray(t)
          ? [{ name: named(t), definition: String(t.definition ?? '') }]
          : [],
      )
    : []
  const children = Array.isArray(body.children)
    ? body.children.map((c) => ({ ...toSpaceManifest(c), name: named(c) }))
    : []
  return { terms, children }
}

const saveSpaceAsTemplateProgram = Effect.fn('saveSpaceAsTemplateProgram')(
  function* (actorId: string, data: { spaceId: string; name: string }) {
    const spaces = yield* serverQuery(() =>
      db
        .select({
          id: space.entityId,
          parentId: space.parentId,
          name: entity.canonicalName,
        })
        .from(space)
        .innerJoin(entity, eq(entity.id, space.entityId)),
    )
    const terms = yield* serverQuery(() =>
      db
        .select({
          spaceId: term.spaceId,
          name: term.name,
          definition: term.definitionMd,
        })
        .from(term),
    )
    const byParent = new Map<string | null, Array<(typeof spaces)[number]>>()
    for (const s of spaces) {
      const list = byParent.get(s.parentId) ?? []
      list.push(s)
      byParent.set(s.parentId, list)
    }
    const capture = (id: string): SpaceManifest => ({
      // Names and skeletons only, never content — a scaffold that copied
      // memos would smuggle one market's research into another.
      terms: terms
        .filter((t) => t.spaceId === id)
        .map((t) => ({ name: t.name, definition: t.definition })),
      children: (byParent.get(id) ?? []).map((c) => ({
        name: c.name,
        ...capture(c.id),
      })),
    })
    const root = spaces.find((s) => s.id === data.spaceId)
    if (!root)
      return yield* new TemplateSourceNotFound({ message: 'Space not found' })
    const body = capture(data.spaceId)
    const [t] = yield* serverQuery(() =>
      db
        .insert(template)
        .values({
          kind: 'space',
          name: data.name,
          body: body,
          createdBy: actorId,
        })
        .returning({ id: template.id }),
    )
    return { id: t.id }
  },
)

export const saveSpaceAsTemplate = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ spaceId: uuid, name: templateName })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(saveSpaceAsTemplateProgram(u.id, data))
  })

/**
 * One space of a manifest stamped under `parentId`, then its children.
 * Stamping is idempotent-ish: an existing same-named child is reused, never
 * duplicated — same insert-if-absent philosophy as the system attribute
 * seeder.
 */
const stampSpaceManifestProgram = Effect.fn('stampSpaceManifestProgram')(
  function* (
    actorId: string,
    name: string,
    m: SpaceManifest,
    parentId: string | undefined,
  ): Effect.fn.Return<string, ServerQueryFailed | ParentSpaceNotFound> {
    const existing = yield* serverQuery(() =>
      db
        .select({ id: space.entityId })
        .from(space)
        .innerJoin(entity, eq(entity.id, space.entityId))
        .where(
          and(
            parentId ? eq(space.parentId, parentId) : isNull(space.parentId),
            eq(entity.canonicalName, name),
          ),
        ),
    )
    const id =
      existing.at(0)?.id ??
      (yield* createSpaceRowProgram(name, parentId ?? null, actorId))
    const existingTerms = yield* serverQuery(() =>
      db.select({ name: term.name }).from(term).where(eq(term.spaceId, id)),
    )
    const have = new Set(existingTerms.map((x) => x.name.toLowerCase()))
    for (const tm of m.terms) {
      if (have.has(tm.name.toLowerCase())) continue
      const [ent] = yield* serverQuery(() =>
        db
          .insert(entity)
          .values({ kind: 'term', canonicalName: tm.name, createdBy: actorId })
          .returning({ id: entity.id }),
      )
      yield* serverQuery(() =>
        db.insert(term).values({
          entityId: ent.id,
          name: tm.name,
          definitionMd: tm.definition,
          spaceId: id,
        }),
      )
    }
    for (const child of m.children) {
      yield* stampSpaceManifestProgram(actorId, child.name, child, id)
    }
    return id
  },
)

const applySpaceTemplateProgram = Effect.fn('applySpaceTemplateProgram')(
  function* (
    actorId: string,
    data: {
      readonly templateId: string
      readonly name: string
      readonly parentId?: string | undefined
    },
  ) {
    const t = (yield* serverQuery(() =>
      db
        .select()
        .from(template)
        .where(
          and(eq(template.id, data.templateId), eq(template.kind, 'space')),
        ),
    )).at(0)
    if (!t)
      return yield* new TemplateSourceNotFound({
        message: 'Template not found',
      })
    const manifest = toSpaceManifest(t.body)
    const rootId = yield* stampSpaceManifestProgram(
      actorId,
      data.name,
      manifest,
      data.parentId,
    )
    yield* serverQuery(() =>
      db.insert(activity).values({
        actorId,
        verb: 'space.created',
        subjectEntityId: rootId,
      }),
    )
    return { id: rootId }
  },
)

export const applySpaceTemplate = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        templateId: uuid,
        name: templateName,
        parentId: Schema.optional(uuid),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(applySpaceTemplateProgram(u.id, data))
  })
