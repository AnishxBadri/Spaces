import type { NoteKind } from './ordering'
import { Effect, Schema } from 'effect'
import { db } from '@spaces/db'
import { entity, entitySpace, link, note } from '@spaces/db/schema'
import { raiseSensitivity } from '@spaces/core/writes/ai/stamp-sensitivity'
import { activity } from '@spaces/db/schema/activity'
import type { NoteBody } from '@spaces/db/schema/kinds'

/**
 * Note creation. Filed and referenced are two mechanisms, never conflated:
 * - Filed is the act: a space files through `entity_space`, a record through
 *   `link(tagged_in, manual)`. Written first; it is what the user asked for.
 * - Referenced is a side effect: the starter `[[mention]]` writes
 *   `link(mentions, extracted)`, stamped as `saveNote` stamps the rows it
 *   owns, so deleting the block removes that row and leaves the filing.
 */

export class NoteCreateFailed extends Schema.TaggedError<NoteCreateFailed>()(
  'NoteCreateFailed',
  { cause: Schema.Defect() },
) {}

/** The record or space the note is started from. Normalized at the handler. */
export type NoteAbout = {
  entityId: string
  label: string
  kind: string
  /** custom records route through their object's slug; '' for the rest */
  objectSlug: string
}

export type CreateNoteInput = {
  about: NoteAbout | null
  noteKind: NoteKind
  /**
   * The note's name at birth. Omitted, the note is born Untitled; a meeting
   * write-up passes the subject the user already typed.
   */
  title?: string
  /**
   * Whether the note opens on the starter mention block. Default true. A
   * meeting write-up passes false: its attendees are filed, and a starter
   * mention would put the note in both lanes of every attendee's Notes.
   */
  starter?: boolean
}

/** The sentence the client is shown; a `Schema.TaggedError` carries none. */
export function noteCreateMessage(failure: unknown): string {
  if (failure instanceof NoteCreateFailed) return 'Could not create note'
  return failure instanceof Error ? failure.message : 'Could not create note'
}

export const createNoteProgram = Effect.fn('createNoteProgram')(function* (
  userId: string,
  input: CreateNoteInput,
): Effect.fn.Return<{ id: string }, NoteCreateFailed> {
  const { about, noteKind } = input
  const title = input.title ?? ''

  // A memo opens on a blank page — it is the author's own view, not a reply
  // to a record — so it gets no starter block and therefore no starter
  // mention. Everything else opens on the thing it is about, unless the
  // caller said otherwise.
  const starter: NoteBody | null =
    about && noteKind !== 'memo' && input.starter !== false
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
                  objectSlug: about.objectSlug,
                },
              },
              { type: 'text', text: ' — ', styles: {} },
            ],
          },
        ]
      : null

  return yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const ent = (
          await tx
            .insert(entity)
            .values({
              kind: 'note',
              // `saveNote` keeps these two in step the same way; a titled
              // note has to be findable by that name from the moment it
              // exists, not from its first save.
              canonicalName: title || 'Untitled',
              createdBy: userId,
            })
            .returning({ id: entity.id })
        ).at(0)
        if (!ent) throw new Error('note entity insert returned no row')

        await tx.insert(note).values({
          entityId: ent.id,
          authorId: userId,
          title,
          kind: noteKind,
          bodyJson: starter,
          bodyMd:
            starter && about
              ? `Mentions: [[${about.label}|entity:${about.entityId}]]\n`
              : '',
        })

        if (about) {
          if (about.kind === 'space') {
            // Filed in the space through entity_space, like every other kind.
            // No link row: `link` cannot express `source` + `confidence`.
            await tx
              .insert(entitySpace)
              .values({
                entityId: ent.id,
                spaceId: about.entityId,
                source: 'manual',
                createdBy: userId,
              })
              .onConflictDoNothing()
            await raiseSensitivity(tx, {
              kind: 'filed',
              entityId: ent.id,
              spaceId: about.entityId,
            })
          } else {
            // The filing, first: the act the button names.
            await tx
              .insert(link)
              .values({
                fromEntityId: ent.id,
                toEntityId: about.entityId,
                relation: 'tagged_in',
                source: 'manual',
                createdBy: userId,
              })
              .onConflictDoNothing()
            // The starter block's mention, second, stamped the way
            // `saveNote` stamps the mentions it owns.
            if (starter) {
              await tx
                .insert(link)
                .values({
                  fromEntityId: ent.id,
                  toEntityId: about.entityId,
                  relation: 'mentions',
                  source: 'extracted',
                  createdBy: userId,
                })
                .onConflictDoNothing()
            }
          }
        }

        await tx.insert(activity).values({
          actorId: userId,
          verb: 'note.created',
          subjectEntityId: about ? about.entityId : ent.id,
          objectEntityId: about ? ent.id : undefined,
        })

        return { id: ent.id }
      }),
    catch: (cause) => new NoteCreateFailed({ cause }),
  })
})
