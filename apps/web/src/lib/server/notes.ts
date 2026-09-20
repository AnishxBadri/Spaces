import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  link,
  note,
  objectDef,
  space,
} from '@spaces/db/schema'
import { canRead, requireUser } from './shared'
import { jsonValue } from '#/lib/json'

export const createNote = createServerFn({ method: 'POST' })
  .validator(
    z
      .object({
        /** Pre-link the note to an entity: starter block with its mention. */
        about: z
          .object({
            entityId: z.string().uuid(),
            label: z.string().max(200),
            kind: z.string().max(30),
            /** custom records route through their object's slug */
            objectSlug: z.string().max(80).optional(),
          })
          .optional(),
        /** memo: the note IS the memo of `about` (tagged_in, not mentions). */
        noteKind: z.enum(['note', 'memo', 'scratch']).optional(),
      })
      .optional(),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const about = data?.about
    const { createNoteProgram, noteCreateMessage } =
      await import('../notes/create')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(createNoteProgram)(u.id, {
        about: about
          ? {
              entityId: about.entityId,
              label: about.label,
              kind: about.kind,
              objectSlug: about.objectSlug ?? '',
            }
          : null,
        noteKind: data?.noteKind ?? 'note',
      })
    } catch (failure) {
      throw new Error(noteCreateMessage(failure))
    }
  })

/**
 * The two lanes of a record's Notes section — filed against it, and merely
 * mentioning it. Visibility and merge state are filtered in SQL; see
 * `lib/notes/list-record.ts`.
 */
export const listRecordNotes = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { listRecordNotesProgram } = await import('../notes/list-record')
    const { effectFn } = await import('./effect')
    return effectFn(listRecordNotesProgram)(u.id, data.entityId)
  })

/**
 * The query behind `listNotes`, minus the request context, so the rows can
 * be exercised without a session — the same reason `entitySearchRows` exists.
 * It has no kind predicate and must not grow one: a scratch note is a note
 * that is listed like any other (SPA-109).
 */
export async function listNoteRows(userId: string) {
  return db
    .select({
      id: note.entityId,
      title: note.title,
      bodyMd: note.bodyMd,
      kind: note.kind,
      updatedAt: note.updatedAt,
      authorId: note.authorId,
      visibility: note.visibility,
    })
    .from(note)
    .innerJoin(entity, eq(entity.id, note.entityId))
    .where(
      and(
        isNull(entity.mergedIntoId),
        // canRead in SQL: shared, or private-and-mine.
        or(eq(note.visibility, 'shared'), eq(note.authorId, userId)),
      ),
    )
    .orderBy(desc(note.updatedAt))
}

export const listNotes = createServerFn().handler(async () => {
  const u = await requireUser()
  const rows = await listNoteRows(u.id)
  return rows.map((r) => ({
    id: r.id,
    title: r.title || 'Untitled',
    // The starter block's `Mentions: [[…]]` marker is a seed, not prose —
    // strip it the way the space page already strips it, or every freshly
    // created note reads as its own wiki-link in the list.
    snippet: r.bodyMd
      .replace(/Mentions:.*$/s, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140),
    kind: r.kind,
    updatedAt: r.updatedAt.toISOString(),
    isPrivate: r.visibility === 'private',
  }))
})

export const getNote = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const row = (
      await db
        .select({
          id: note.entityId,
          title: note.title,
          bodyJson: note.bodyJson,
          kind: note.kind,
          updatedAt: note.updatedAt,
          authorId: note.authorId,
          visibility: note.visibility,
        })
        .from(note)
        .where(eq(note.entityId, data.id))
    ).at(0)
    // "Not found" on purpose — a 403 would confirm a private note exists.
    if (!row || !canRead(u, row)) throw new Error('Note not found')
    // Backlinks: anything whose content mentions this note.
    const backlinks = await db
      .select({
        fromId: link.fromEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(and(eq(link.toEntityId, data.id), eq(link.relation, 'mentions')))
    // Spaces this note is filed in — the picker's current state.
    const spaces = await db
      .select({ id: space.entityId, name: entity.canonicalName })
      .from(entitySpace)
      .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(entitySpace.entityId, data.id))
      .orderBy(asc(entity.canonicalName))
    // Records this note is filed against — the *outbound* tagged_in edges,
    // which is the opposite direction from `backlinks` above. `objectSlug`
    // rides along so a custom record's chip routes through `/o/<slug>/<id>`
    // (`recordPath`); a merged-away target drops out rather than linking to
    // a tombstone.
    const filedAgainst = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        objectSlug: objectDef.slug,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(
        and(
          eq(link.fromEntityId, data.id),
          eq(link.relation, 'tagged_in'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(entity.canonicalName))

    return {
      id: row.id,
      title: row.title,
      bodyJson: row.bodyJson,
      kind: row.kind,
      updatedAt: row.updatedAt.toISOString(),
      backlinks,
      spaces,
      filedAgainst,
      isPrivate: row.visibility === 'private',
      isMine: row.authorId === u.id,
    }
  })

/**
 * What deleting this note would unlink, and what would refuse it — the two
 * things the confirm dialog has to say before it offers a Delete button.
 */
export const previewNoteDeletion = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { noteDeleteImpactProgram, noteDeleteMessage } =
      await import('../notes/delete')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(noteDeleteImpactProgram)(u.id, data.id)
    } catch (failure) {
      throw new Error(noteDeleteMessage(failure))
    }
  })

/**
 * Hard delete, no trash — decided 2026-09-19 (CONTEXT.md → The note model).
 * The note goes; what it fed survives, because the registry says which edges
 * die with it and which rows only lose an edge.
 *
 * The typed failures are turned into sentences here rather than allowed to
 * reject as they are: Effect rejects with the `Blocked` value itself, which
 * carries no `message`, so the mandate's refusal would otherwise reach the
 * dialog as an empty string.
 */
export const deleteNote = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { deleteNoteProgram, noteDeleteMessage } =
      await import('../notes/delete')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(deleteNoteProgram)(u.id, data.id)
    } catch (failure) {
      throw new Error(noteDeleteMessage(failure))
    }
  })

/**
 * Visibility is the author's choice alone — an admin flipping someone's
 * private note shared would break the trust the default-shared model
 * depends on.
 */
export const setNoteVisibility = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      visibility: z.enum(['shared', 'private']),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const row = (
      await db
        .select({ authorId: note.authorId, visibility: note.visibility })
        .from(note)
        .where(eq(note.entityId, data.id))
    ).at(0)
    // Same collapse as getNote: an unreadable private note answers exactly
    // like a nonexistent one — a distinct error would confirm it exists.
    if (!row || !canRead(u, row)) throw new Error('Note not found')
    if (row.authorId !== u.id) {
      throw new Error('Only the author can change a note’s visibility.')
    }
    await db
      .update(note)
      .set({ visibility: data.visibility, updatedAt: new Date() })
      .where(eq(note.entityId, data.id))
    return { ok: true }
  })

/**
 * Kind is a promote or a demote of the same row — same entity, same links,
 * same filing (CONTEXT.md → The note model: "a memo is a note with the flag
 * up"). Deliberately *not* author-only, unlike visibility: a shared note's
 * genre is the team's reading of it, so whoever may read it may change it.
 *
 * The typed failure is turned into a sentence here for the same reason the
 * delete path does it — `Effect.runPromise` rejects with a
 * `Schema.TaggedError`, which carries no `message`.
 */
export const setNoteKind = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      kind: z.enum(['note', 'memo', 'scratch']),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { setNoteKindProgram, noteKindMessage } =
      await import('../notes/kind')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(setNoteKindProgram)(u.id, data.id, data.kind)
    } catch (failure) {
      throw new Error(noteKindMessage(failure))
    }
  })

/**
 * File this note against a record — the record half of the two filing
 * mechanisms (CONTEXT.md → The note model). The kind allowlist is the
 * program's, not this validator's: the picker only ever offers the four
 * kinds, but the rule is enforced where it cannot be skipped.
 */
export const fileNoteAgainst = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), targetId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { fileNoteAgainstProgram, noteFilingMessage } =
      await import('../notes/filing')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(fileNoteAgainstProgram)(
        u.id,
        data.id,
        data.targetId,
      )
    } catch (failure) {
      throw new Error(noteFilingMessage(failure))
    }
  })

/**
 * Remove one filing, and only the filing: a `mentions` edge to the same
 * record survives, so the note moves to that record's "Mentions this" lane
 * rather than off its page.
 */
export const unfileNoteFrom = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), targetId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { unfileNoteFromProgram, noteFilingMessage } =
      await import('../notes/filing')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(unfileNoteFromProgram)(u.id, data.id, data.targetId)
    } catch (failure) {
      throw new Error(noteFilingMessage(failure))
    }
  })

const saveNoteInput = z.object({
  id: z.string().uuid(),
  title: z.string().max(300),
  /** Body fields absent = title-only save; body stays untouched. */
  body: z
    .object({
      bodyJson: z.array(jsonValue),
      bodyMd: z.string().max(500_000),
      /** entity ids mentioned in the doc — extracted client-side from JSON */
      mentionIds: z.array(z.string().uuid()).max(500),
    })
    .optional(),
})

export const saveNote = createServerFn({ method: 'POST' })
  .validator(saveNoteInput)
  .handler(async ({ data }) => {
    const u = await requireUser()

    // Shared notes are team-editable; private ones are the author's alone.
    const existing = (
      await db
        .select({ authorId: note.authorId, visibility: note.visibility })
        .from(note)
        .where(eq(note.entityId, data.id))
    ).at(0)
    if (!existing || !canRead(u, existing)) throw new Error('Note not found')

    await db.transaction(async (tx) => {
      await tx
        .update(note)
        .set({
          title: data.title,
          updatedAt: new Date(),
          ...(data.body
            ? { bodyJson: data.body.bodyJson, bodyMd: data.body.bodyMd }
            : {}),
        })
        .where(eq(note.entityId, data.id))
      await tx
        .update(entity)
        .set({ canonicalName: data.title || 'Untitled' })
        .where(eq(entity.id, data.id))

      if (!data.body) return

      // Diff-sync mention links (only rows this sync owns: extracted).
      const existingLinks = await tx
        .select({ id: link.id, toEntityId: link.toEntityId })
        .from(link)
        .where(
          and(
            eq(link.fromEntityId, data.id),
            eq(link.relation, 'mentions'),
            eq(link.source, 'extracted'),
          ),
        )
      const wanted = new Set(data.body.mentionIds.filter((m) => m !== data.id))
      const current = new Set(existingLinks.map((e) => e.toEntityId))
      for (const row of existingLinks) {
        if (!wanted.has(row.toEntityId)) {
          await tx.delete(link).where(eq(link.id, row.id))
        }
      }
      for (const target of wanted) {
        if (!current.has(target)) {
          await tx
            .insert(link)
            .values({
              fromEntityId: data.id,
              toEntityId: target,
              relation: 'mentions',
              source: 'extracted',
              createdBy: u.id,
            })
            .onConflictDoNothing()
        }
      }
    })
    return { savedAt: new Date().toISOString() }
  })
