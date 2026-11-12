import { excerpt } from '@spaces/core/context/excerpt'
import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  link,
  note,
  objectDef,
  space,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { noteWidenedSql } from '@spaces/core/writes/read/can-read-sql'
import { canRead, requireUser } from './shared'
import { liveSpaceSql } from '#/lib/spaces/live'
import { noteKindInput } from '#/lib/notes/kind-input'
import { jsonValue } from '@spaces/core/json'
import { uuidString } from '@spaces/core/attributes/registry'
import { input } from './input'
import { serverQuery } from './query'

const uuid = Schema.String.check(Schema.isUUID())

/**
 * A note the reader may not touch. "Not found" stands for a private note
 * too: a distinct refusal would confirm it exists.
 */
class NoteRefused extends Schema.TaggedError<NoteRefused>()('NoteRefused', {
  message: Schema.String,
}) {}

export const createNote = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.UndefinedOr(
        Schema.Struct({
          /** Pre-link the note to an entity: starter block with its mention. */
          about: Schema.optional(
            Schema.Struct({
              entityId: uuid,
              label: Schema.String.check(Schema.isMaxLength(200)),
              kind: Schema.String.check(Schema.isMaxLength(30)),
              /** custom records route through their object's slug */
              objectSlug: Schema.optional(
                Schema.String.check(Schema.isMaxLength(80)),
              ),
            }),
          ),
          /** memo: the note IS the memo of `about` (tagged_in, not mentions). */
          noteKind: Schema.optional(noteKindInput),
        }),
      ),
    ),
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
 * The three lanes of a record's Notes tab — filed against it, from its
 * meetings, and merely mentioning it. Visibility and merge state are
 * filtered in SQL; see `listRecordNotesProgram`.
 */
export const listRecordNotes = createServerFn()
  .validator(input(Schema.Struct({ entityId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { listRecordNotesProgram } = await import('../notes/list-record')
    const { effectFn } = await import('./effect')
    return effectFn(listRecordNotesProgram)(u.id, data.entityId)
  })

const listNotesProgram = Effect.fn('listNotesProgram')(function* (
  userId: string,
) {
  const { listNoteRows } = yield* Effect.promise(
    () => import('../notes/list-rows'),
  )
  const rows = yield* Effect.promise(() => listNoteRows(userId))
  return rows.map((r) => ({
    id: r.id,
    title: r.title || 'Untitled',
    snippet: excerpt(r.bodyMd, { noteBody: true, max: 140 }),
    kind: r.kind,
    updatedAt: r.updatedAt.toISOString(),
    isPrivate: r.visibility === 'private',
  }))
})

/** The rows are `listNoteRows`; this shapes them. */
export const listNotes = createServerFn().handler(async () => {
  const u = await requireUser()
  return Effect.runPromise(listNotesProgram(u.id))
})

const getNoteProgram = Effect.fn('getNoteProgram')(function* (
  userId: string,
  noteId: string,
) {
  const viewer = { id: userId }
  const row = (yield* serverQuery(() =>
    db
      .select({
        id: note.entityId,
        title: note.title,
        bodyJson: note.bodyJson,
        kind: note.kind,
        createdAt: entity.createdAt,
        updatedAt: note.updatedAt,
        authorId: note.authorId,
        author: user.name,
        visibility: note.visibility,
        // An email body its owner widened to the reader.
        widened: noteWidenedSql(userId),
      })
      .from(note)
      .innerJoin(entity, eq(entity.id, note.entityId))
      .innerJoin(user, eq(user.id, note.authorId))
      .where(eq(note.entityId, noteId)),
  )).at(0)
  // "Not found" on purpose — a 403 would confirm a private note exists.
  if (!row || !canRead(viewer, row))
    return yield* new NoteRefused({ message: 'Note not found' })
  // Backlinks: anything whose content mentions this note.
  const backlinks = yield* serverQuery(() =>
    db
      .select({
        fromId: link.fromEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(and(eq(link.toEntityId, noteId), eq(link.relation, 'mentions'))),
  )
  // What the body mentions: the outbound direction of the edge above,
  // written from the body at save. A private note the reader cannot see
  // drops out rather than leaking its name; so does a merged-away target.
  const mentions = (yield* serverQuery(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        objectSlug: objectDef.slug,
        objectLabel: objectDef.singular,
        visibility: note.visibility,
        authorId: note.authorId,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .leftJoin(note, eq(note.entityId, entity.id))
      .where(
        and(
          eq(link.fromEntityId, noteId),
          eq(link.relation, 'mentions'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(link.createdAt)),
  ))
    .filter((r) => canRead(viewer, r))
    .map(({ id, name, kind, objectSlug, objectLabel }) => ({
      id,
      name,
      kind,
      objectSlug,
      objectLabel,
    }))
  // Spaces this note is filed in, in the order it was filed; an archived
  // one stays, flagged, and its row dims.
  const spaces = yield* serverQuery(() =>
    db
      .select({
        id: space.entityId,
        name: entity.canonicalName,
        archived: sql<boolean>`not ${liveSpaceSql}`,
      })
      .from(entitySpace)
      .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(entitySpace.entityId, noteId))
      .orderBy(asc(entitySpace.createdAt)),
  )
  // Records this note is filed against — the *outbound* tagged_in edges,
  // which is the opposite direction from `backlinks` above, in the order
  // they were filed. `objectSlug` rides along so a custom record's row
  // routes through `/o/<slug>/<id>` (`recordPath`); a merged-away target
  // drops out rather than linking to a tombstone.
  const filedAgainst = yield* serverQuery(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        objectSlug: objectDef.slug,
        objectLabel: objectDef.singular,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(
        and(
          eq(link.fromEntityId, noteId),
          eq(link.relation, 'tagged_in'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(link.createdAt)),
  )

  // The newer version that replaced this note, if one the reader can see
  // exists, and when it replaced it.
  const replacedBy =
    (yield* serverQuery(() =>
      db
        .select({
          id: note.entityId,
          title: note.title,
          visibility: note.visibility,
          authorId: note.authorId,
          at: link.createdAt,
        })
        .from(link)
        .innerJoin(note, eq(note.entityId, link.fromEntityId))
        .where(
          and(eq(link.toEntityId, noteId), eq(link.relation, 'supersedes')),
        )
        .orderBy(desc(link.createdAt)),
    ))
      .filter((r) => canRead(viewer, r))
      .map((r) => ({
        id: r.id,
        title: r.title || 'Untitled',
        at: r.at.toISOString(),
      }))
      .at(0) ?? null

  // A recorder's note opens at the recorder too.
  const { noteRecorderLinkProgram } = yield* Effect.promise(
    () => import('../interactions/recorder-links'),
  )
  const openIn = yield* noteRecorderLinkProgram(noteId)
  // …and is marked with the tool it was filed from.
  const { noteViaProgram } = yield* Effect.promise(() => import('../notes/via'))
  const via = yield* noteViaProgram(noteId)

  return {
    id: row.id,
    title: row.title,
    bodyJson: row.bodyJson,
    kind: row.kind,
    author: row.author,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    backlinks,
    mentions,
    spaces,
    filedAgainst,
    isPrivate: row.visibility === 'private',
    isMine: row.authorId === userId,
    replacedBy,
    openIn,
    via,
  }
})

export const getNote = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(getNoteProgram(u.id, data.id))
  })

/**
 * What deleting this note would unlink, and what would refuse it — the two
 * things the confirm dialog has to say before it offers a Delete button.
 */
export const previewNoteDeletion = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
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
 * Hard delete, no trash. The note goes; what it fed survives, because the registry says which edges
 * die with it and which rows only lose an edge.
 *
 * The typed failures are turned into sentences here rather than allowed to
 * reject as they are: Effect rejects with the `Blocked` value itself, which
 * carries no `message`, so the mandate's refusal would otherwise reach the
 * dialog as an empty string.
 */
export const deleteNote = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid })))
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

const setNoteVisibilityProgram = Effect.fn('setNoteVisibilityProgram')(
  function* (userId: string, id: string, visibility: 'shared' | 'private') {
    const row = (yield* serverQuery(() =>
      db
        .select({ authorId: note.authorId, visibility: note.visibility })
        .from(note)
        .where(eq(note.entityId, id)),
    )).at(0)
    // Same collapse as getNote: an unreadable private note answers exactly
    // like a nonexistent one — a distinct error would confirm it exists.
    if (!row || !canRead({ id: userId }, row))
      return yield* new NoteRefused({ message: 'Note not found' })
    if (row.authorId !== userId) {
      return yield* new NoteRefused({
        message: 'Only the author can change a note’s visibility.',
      })
    }
    yield* serverQuery(() =>
      db
        .update(note)
        .set({ visibility, updatedAt: new Date() })
        .where(eq(note.entityId, id)),
    )
    return { ok: true }
  },
)

/**
 * Visibility is the author's choice alone — an admin flipping someone's
 * private note shared would break the trust the default-shared model
 * depends on.
 */
export const setNoteVisibility = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: uuid,
        visibility: Schema.Literals(['shared', 'private']),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(
      setNoteVisibilityProgram(u.id, data.id, data.visibility),
    )
  })

/**
 * Kind is a promote or a demote of the same row — same entity, same links,
 * same filing ("a memo is a note with the flag up"). Deliberately *not* author-only, unlike visibility: a shared note's
 * genre is the team's reading of it, so whoever may read it may change it.
 *
 * The typed failure is turned into a sentence here for the same reason the
 * delete path does it — `Effect.runPromise` rejects with a
 * `Schema.TaggedError`, which carries no `message`.
 */
export const setNoteKind = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid, kind: noteKindInput })))
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
 * mechanisms. The kind allowlist is the
 * program's, not this validator's: the picker only ever offers the four
 * kinds, but the rule is enforced where it cannot be skipped.
 */
export const fileNoteAgainst = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid, targetId: uuid })))
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
  .validator(input(Schema.Struct({ id: uuid, targetId: uuid })))
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

const saveNoteInput = Schema.Struct({
  id: uuidString,
  title: Schema.String.check(Schema.isMaxLength(300)),
  /** Body fields absent = title-only save; body stays untouched. */
  body: Schema.optional(
    Schema.Struct({
      bodyJson: Schema.mutable(Schema.Array(jsonValue)),
      bodyMd: Schema.String.check(Schema.isMaxLength(500_000)),
      /** entity ids mentioned in the doc — extracted client-side from JSON */
      mentionIds: Schema.mutable(Schema.Array(uuidString)).check(
        Schema.isMaxLength(500),
      ),
    }),
  ),
})

export const saveNote = createServerFn({ method: 'POST' })
  .validator(input(saveNoteInput))
  .handler(async ({ data }) => {
    const u = await requireUser()
    // `saveNoteProgram` also diff-syncs the note's `mentions` edges,
    // `[[mention]]` chips and glossary terms together.
    const { saveNoteProgram, noteSaveMessage } = await import('../notes/save')
    const { effectFn } = await import('./effect')
    try {
      const { savedAt } = await effectFn(saveNoteProgram)(u.id, {
        id: data.id,
        title: data.title,
        ...(data.body ? { body: data.body } : {}),
      })
      return { savedAt }
    } catch (failure) {
      throw new Error(noteSaveMessage(failure))
    }
  })
