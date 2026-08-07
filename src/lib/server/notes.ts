import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { entity, entitySpace, link, note, space } from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { canRead, requireUser } from './shared'
import type { Json } from './shared'

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
          })
          .optional(),
        /** memo: the note IS the memo of `about` (tagged_in, not mentions). */
        noteKind: z.enum(['note', 'memo']).optional(),
      })
      .optional(),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const about = data?.about
    const noteKind = data?.noteKind ?? 'note'
    return db.transaction(async (tx) => {
      const [ent] = await tx
        .insert(entity)
        .values({ kind: 'note', canonicalName: 'Untitled', createdBy: u.id })
        .returning({ id: entity.id })

      const bodyJson = about
        ? [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'mention',
                  props: {
                    entityId: about.entityId,
                    label: about.label,
                    kind: about.kind,
                  },
                },
                { type: 'text', text: ' — ', styles: {} },
              ],
            },
          ]
        : null

      await tx.insert(note).values({
        entityId: ent.id,
        authorId: u.id,
        kind: noteKind,
        bodyJson: noteKind === 'memo' ? null : bodyJson,
        bodyMd:
          about && noteKind !== 'memo'
            ? `Mentions: [[${about.label}|entity:${about.entityId}]]\n`
            : '',
      })
      if (about) {
        if (about.kind === 'space') {
          // Written while standing in the space, so it is filed there, not
          // merely referenced — and it files through entity_space like every
          // other kind, inheriting its provenance/confidence story.
          await tx
            .insert(entitySpace)
            .values({
              entityId: ent.id,
              spaceId: about.entityId,
              source: 'manual',
              createdBy: u.id,
            })
            .onConflictDoNothing()
        } else {
          await tx.insert(link).values({
            fromEntityId: ent.id,
            toEntityId: about.entityId,
            relation: 'mentions',
            source: 'extracted',
            createdBy: u.id,
          })
        }
      }
      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'note.created',
        subjectEntityId: about ? about.entityId : ent.id,
        objectEntityId: about ? ent.id : undefined,
      })
      return { id: ent.id }
    })
  })

export const listNotes = createServerFn().handler(async () => {
  const u = await requireUser()
  const rows = await db
    .select({
      id: note.entityId,
      title: note.title,
      bodyMd: note.bodyMd,
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
        or(eq(note.visibility, 'shared'), eq(note.authorId, u.id)),
      ),
    )
    .orderBy(desc(note.updatedAt))
  return rows.map((r) => ({
    id: r.id,
    title: r.title || 'Untitled',
    snippet: r.bodyMd.replace(/\s+/g, ' ').slice(0, 140),
    updatedAt: r.updatedAt.toISOString(),
    isPrivate: r.visibility === 'private',
  }))
})

export const getNote = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const [row] = await db
      .select({
        id: note.entityId,
        title: note.title,
        bodyJson: note.bodyJson,
        updatedAt: note.updatedAt,
        authorId: note.authorId,
        visibility: note.visibility,
      })
      .from(note)
      .where(eq(note.entityId, data.id))
    // "Not found" on purpose — a 403 would confirm a private note exists.
    if (!row || !canRead(u, row)) throw new Error('Note not found')
    // jsonb comes back as unknown; it's a BlockNote document array.
    const bodyJson = row.bodyJson as Array<Json> | null

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

    return {
      id: row.id,
      title: row.title,
      bodyJson,
      updatedAt: row.updatedAt.toISOString(),
      backlinks,
      spaces,
      isPrivate: row.visibility === 'private',
      isMine: row.authorId === u.id,
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
    const [row] = await db
      .select({ authorId: note.authorId, visibility: note.visibility })
      .from(note)
      .where(eq(note.entityId, data.id))
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

const saveNoteInput = z.object({
  id: z.string().uuid(),
  title: z.string().max(300),
  /** Body fields absent = title-only save; body stays untouched. */
  body: z
    .object({
      bodyJson: z.unknown(),
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
    const [existing] = await db
      .select({ authorId: note.authorId, visibility: note.visibility })
      .from(note)
      .where(eq(note.entityId, data.id))
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
      const existing = await tx
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
      const current = new Set(existing.map((e) => e.toEntityId))
      for (const row of existing) {
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
