import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { entity, space, term } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { template } from '@spaces/db/schema/templates'
import { toObjectKind } from '@spaces/core/attributes/registry'
import { requireUser } from './shared'
import type { Json } from './shared'

/**
 * Templates — standardized capture, never automation. All creation is
 * by-example: save an existing note/record/space as the pattern. Member-
 * writable like the rest of the content layer.
 */

// ---------- shared ----------

const KINDS = ['note', 'space', 'record'] as const

export const listTemplates = createServerFn()
  .validator(
    z
      .object({
        kind: z.enum(KINDS).optional(),
        objectKind: z.enum(['company', 'person', 'deal']).optional(),
        includeArchived: z.boolean().optional(),
      })
      .optional(),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const rows = await db
      .select()
      .from(template)
      .where(
        and(
          data?.kind ? eq(template.kind, data.kind) : undefined,
          data?.objectKind
            ? eq(template.objectKind, data.objectKind)
            : undefined,
          data?.includeArchived ? undefined : eq(template.archived, false),
        ),
      )
      .orderBy(asc(template.sortOrder), asc(template.name))
    return rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      objectKind: t.objectKind,
      // The genre a note template stamps (SPA-131); null on every
      // space/record template and on note templates saved before the column.
      noteKind: t.noteKind,
      name: t.name,
      body: t.body,
      suggestOn: t.suggestOn,
      archived: t.archived,
    }))
  })

export const updateTemplate = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(120).optional(),
      archived: z.boolean().optional(),
      suggestOn: z.array(z.string().max(30)).max(10).optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    await db
      .update(template)
      .set({
        ...(data.name ? { name: data.name } : {}),
        ...(data.archived !== undefined ? { archived: data.archived } : {}),
        ...(data.suggestOn !== undefined ? { suggestOn: data.suggestOn } : {}),
        updatedAt: new Date(),
      })
      .where(eq(template.id, data.id))
    return { ok: true }
  })

// ---------- note templates ----------

/** Capture is `captureNoteTemplate` (`lib/notes/templates.ts`). */
export const saveNoteAsTemplate = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      noteId: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { captureNoteTemplate } = await import('../notes/templates')
    return captureNoteTemplate(u.id, data)
  })

/** Stamp is `stampNoteTemplate` (`lib/notes/templates.ts`). */
export const createNoteFromTemplate = createServerFn({ method: 'POST' })
  .validator(z.object({ templateId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { stampNoteTemplate } = await import('../notes/templates')
    return stampNoteTemplate(u.id, data)
  })

// ---------- record templates ----------

/** Slug types that never belong in a template's defaults. */
const NON_TEMPLATABLE_TYPES = new Set(['record_reference', 'actor_reference'])

export const saveRecordAsTemplate = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      recordId: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const row = (
      await db
        .select({ kind: entity.kind, values: entity.values })
        .from(entity)
        .where(and(eq(entity.id, data.recordId), isNull(entity.mergedIntoId)))
    ).at(0)
    if (!row || !['company', 'person', 'deal'].includes(row.kind)) {
      throw new Error('Record not found')
    }
    const { getRegistry } = await import('../attributes/values')
    const core = toObjectKind(row.kind)
    if (!core) throw new Error('Record not found')
    const registry = await getRegistry(core)
    const templatable = new Map(
      registry
        .filter((d) => !NON_TEMPLATABLE_TYPES.has(d.type) && !d.archived)
        .map((d) => [d.slug, d]),
    )
    const values = Object.fromEntries(
      Object.entries(row.values).filter(
        ([slug, v]) => templatable.has(slug) && v !== null,
      ),
    )
    const [t] = await db
      .insert(template)
      .values({
        kind: 'record',
        objectKind: row.kind,
        name: data.name,
        body: { values },
        suggestOn: [row.kind],
        createdBy: u.id,
      })
      .returning({ id: template.id })
    return { id: t.id }
  })

// Record templates have no apply fn: the create modal fetches the body and
// PRE-FILLS its fields, visibly and editably. Nothing writes silently.

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

export const saveSpaceAsTemplate = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      spaceId: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const spaces = await db
      .select({
        id: space.entityId,
        parentId: space.parentId,
        name: entity.canonicalName,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
    const terms = await db
      .select({
        spaceId: term.spaceId,
        name: term.name,
        definition: term.definitionMd,
      })
      .from(term)
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
    if (!root) throw new Error('Space not found')
    const body = capture(data.spaceId)
    const [t] = await db
      .insert(template)
      .values({
        kind: 'space',
        name: data.name,
        body: body,
        createdBy: u.id,
      })
      .returning({ id: template.id })
    return { id: t.id }
  })

export const applySpaceTemplate = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      templateId: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
      parentId: z.string().uuid().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const t = (
      await db
        .select()
        .from(template)
        .where(
          and(eq(template.id, data.templateId), eq(template.kind, 'space')),
        )
    ).at(0)
    if (!t) throw new Error('Template not found')
    const manifest = toSpaceManifest(t.body)

    const { createSpaceRow } = await import('./shared')

    // Stamping is idempotent-ish: an existing same-named child is reused,
    // never duplicated — same insert-if-absent philosophy as the system
    // attribute seeder.
    async function apply(
      name: string,
      m: SpaceManifest,
      parentId: string | undefined,
    ): Promise<string> {
      const existing = await db
        .select({ id: space.entityId })
        .from(space)
        .innerJoin(entity, eq(entity.id, space.entityId))
        .where(
          and(
            parentId ? eq(space.parentId, parentId) : isNull(space.parentId),
            eq(entity.canonicalName, name),
          ),
        )
      const id =
        existing[0]?.id ?? (await createSpaceRow(name, parentId ?? null, u.id))
      const existingTerms = await db
        .select({ name: term.name })
        .from(term)
        .where(eq(term.spaceId, id))
      const have = new Set(existingTerms.map((x) => x.name.toLowerCase()))
      for (const tm of m.terms) {
        if (have.has(tm.name.toLowerCase())) continue
        const [ent] = await db
          .insert(entity)
          .values({ kind: 'term', canonicalName: tm.name, createdBy: u.id })
          .returning({ id: entity.id })
        await db.insert(term).values({
          entityId: ent.id,
          name: tm.name,
          definitionMd: tm.definition,
          spaceId: id,
        })
      }
      for (const child of m.children) {
        await apply(child.name, child, id)
      }
      return id
    }

    const rootId = await apply(data.name, manifest, data.parentId)
    await db.insert(activity).values({
      actorId: u.id,
      verb: 'space.created',
      subjectEntityId: rootId,
    })
    return { id: rootId }
  })
