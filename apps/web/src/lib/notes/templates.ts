import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { template } from '@spaces/db/schema/templates'
import { canRead } from '@spaces/core/read-policy'
import type { Json } from '@spaces/core/json'
import type { Tx } from '@spaces/core/writes/attributes/values'
import {
  NoteRowMissing,
  NotesQueryFailed,
  notesQuery,
  notesQueryFailed,
} from './query'

/**
 * Note-template capture and stamp, minus the request context, so the suite
 * can drive them. Kept out of the server-fn modules: a plain export there
 * keeps its imports alive in the client bundle.
 */

/** The note or the template is not there, or not the reader's to read. */
export class NoteTemplateRefused extends Schema.TaggedError<NoteTemplateRefused>()(
  'NoteTemplateRefused',
  { message: Schema.String },
) {}

/**
 * Mentions are stripped to their plain-text labels at capture. A template
 * holding a real entity reference would materialize link rows to that
 * entity on every instantiation — ghost backlinks from documents that
 * merely share a shape.
 */
function stripMentions(node: Json): Json {
  if (Array.isArray(node)) return node.map(stripMentions)
  if (node === null || typeof node !== 'object') return node
  if (node.type === 'mention') {
    const props = node.props
    const label =
      props !== null && typeof props === 'object' && !Array.isArray(props)
        ? props.label
        : undefined
    return {
      type: 'text',
      text: typeof label === 'string' ? label : '',
      styles: {},
    }
  }
  const out: { [k: string]: Json } = { ...node }
  if (Array.isArray(node.content)) out.content = node.content.map(stripMentions)
  if (Array.isArray(node.children))
    out.children = node.children.map(stripMentions)
  return out
}

/**
 * Capture. A template stamps a genre, not just a shape, so the source note's
 * kind is captured with its body (a memo saves `note_kind = 'memo'`).
 * Mentions are stripped and the body is a copy.
 */
export const captureNoteTemplateProgram = Effect.fn('captureNoteTemplate')(
  function* (userId: string, input: { noteId: string; name: string }) {
    const row = (yield* notesQuery(() =>
      db
        .select({
          bodyJson: note.bodyJson,
          kind: note.kind,
          authorId: note.authorId,
          visibility: note.visibility,
        })
        .from(note)
        .where(eq(note.entityId, input.noteId)),
    )).at(0)
    if (!row || !canRead({ id: userId }, row))
      return yield* new NoteTemplateRefused({ message: 'Note not found' })
    const body = stripMentions(row.bodyJson ?? [])
    const t = (yield* notesQuery(() =>
      db
        .insert(template)
        .values({
          kind: 'note',
          noteKind: row.kind,
          name: input.name,
          body: body ?? [],
          createdBy: userId,
        })
        .returning({ id: template.id }),
    )).at(0)
    if (!t)
      return yield* new NoteRowMissing({
        message: 'Template insert returned no row',
      })
    return { id: t.id }
  },
)

/** {@link captureNoteTemplateProgram}, for a caller that is not a program. */
export const captureNoteTemplate = (
  userId: string,
  input: { noteId: string; name: string },
): Promise<{ id: string }> =>
  Effect.runPromise(captureNoteTemplateProgram(userId, input))

/**
 * Stamp. The template's `note_kind` becomes the new note's kind; null falls
 * through to the column default (deliberately no backfill).
 * - Copy, not reference, and mention-free: no `link` row is written.
 * - Not `createNoteProgram`: that writes a note born about something, with
 *   filing and starter-mention rows; a template note is about nothing.
 */
export const stampNoteTemplateProgram = Effect.fn('stampNoteTemplate')(
  function* (userId: string, input: { templateId: string }) {
    const t = (yield* notesQuery(() =>
      db
        .select()
        .from(template)
        .where(
          and(eq(template.id, input.templateId), eq(template.kind, 'note')),
        ),
    )).at(0)
    if (!t)
      return yield* new NoteTemplateRefused({ message: 'Template not found' })
    // The stamp's own failures come out of the transaction already tagged;
    // only what drizzle throws around them (begin, commit) is wrapped here.
    return yield* Effect.tryPromise({
      try: () =>
        db.transaction((tx) => Effect.runPromise(stampInTx(tx, userId, t))),
      catch: (cause) =>
        cause instanceof NoteRowMissing || cause instanceof NotesQueryFailed
          ? cause
          : notesQueryFailed(cause),
    })
  },
)

/** {@link stampNoteTemplateProgram}, for a caller that is not a program. */
export const stampNoteTemplate = (
  userId: string,
  input: { templateId: string },
): Promise<{ id: string }> =>
  Effect.runPromise(stampNoteTemplateProgram(userId, input))

/** The note, its row and its activity, inside the stamp's transaction. */
const stampInTx = Effect.fn('stampNoteTemplateInTx')(function* (
  tx: Tx,
  userId: string,
  t: typeof template.$inferSelect,
) {
  const ent = (yield* notesQuery(() =>
    tx
      .insert(entity)
      .values({ kind: 'note', canonicalName: t.name, createdBy: userId })
      .returning({ id: entity.id }),
  )).at(0)
  if (!ent)
    return yield* new NoteRowMissing({
      message: 'note entity insert returned no row',
    })
  // Copy, not reference — divergence after stamping is the point.
  yield* notesQuery(() =>
    tx.insert(note).values({
      entityId: ent.id,
      authorId: userId,
      title: t.name,
      ...(t.noteKind ? { kind: t.noteKind } : {}),
      bodyJson: Array.isArray(t.body) ? t.body : [],
      bodyMd: '',
    }),
  )
  yield* notesQuery(() =>
    tx.insert(activity).values({
      actorId: userId,
      verb: 'note.created',
      subjectEntityId: ent.id,
    }),
  )
  return { id: ent.id }
})
