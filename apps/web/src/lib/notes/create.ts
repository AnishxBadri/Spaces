import type { NoteKind } from './ordering'
import { Effect, Schema } from 'effect'
import { db } from '@spaces/db'
import { entity, entitySpace, link, note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { NoteBody } from '@spaces/db/schema/kinds'

/**
 * Note creation (SPA-104), Effect-first behind `effectFn` per the ratchet.
 *
 * The bug this file closes: "Note about this" on a record used to write a
 * single `link(mentions, extracted)` row, so a note started from a company
 * was *referenced* by it and never *filed* against it — and because
 * `saveNote` diff-syncs exactly the extracted mentions it owns, deleting the
 * starter mention block took the note's only edge with it.
 *
 * Two mechanisms, never conflated (CONTEXT.md → Filed vs referenced):
 *
 * - **Filed** is an act. A space files through `entity_space`, which is the
 *   one filing mechanism for every kind and carries `source`/`confidence`;
 *   a record files through `link(tagged_in, manual)`. Written first, because
 *   it is the thing the user asked for.
 * - **Referenced** is a side effect of writing. The starter block's
 *   `[[mention]]` materializes `link(mentions, extracted)` — stamped exactly
 *   as `saveNote`'s diff-sync stamps the rows it owns, so the next save
 *   treats it as its own and removing the block removes the row. The filing
 *   is untouched by that, which is the whole point.
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

  // A memo opens on a blank page — it is the author's own view, not a reply
  // to a record — so it gets no starter block and therefore no starter
  // mention. Everything else opens on the thing it is about.
  const starter: NoteBody | null =
    about && noteKind !== 'memo'
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
              canonicalName: 'Untitled',
              createdBy: userId,
            })
            .returning({ id: entity.id })
        ).at(0)
        if (!ent) throw new Error('note entity insert returned no row')

        await tx.insert(note).values({
          entityId: ent.id,
          authorId: userId,
          kind: noteKind,
          bodyJson: starter,
          bodyMd:
            starter && about
              ? `Mentions: [[${about.label}|entity:${about.entityId}]]\n`
              : '',
        })

        if (about) {
          if (about.kind === 'space') {
            // Written while standing in the space, so it is filed there, not
            // merely referenced — and it files through entity_space like
            // every other kind, inheriting its provenance/confidence story.
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
