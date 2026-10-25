import { entity, link, note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { NotePayload } from '@spaces/core/ai/note'
import type { Tx } from '@spaces/core/writes/attributes/values'
import { noteBodyFromMarkdown } from '@spaces/core/notes/markdown-blocks'

/**
 * A note written server-side with a body, inside `acceptProgram`'s
 * transaction, so note, edges and the suggestion's flip commit together.
 * - The accepter is `created_by` and `author_id`: the person who decided is
 *   the actor. `body_md` is serialized from the same blocks as `body_json`.
 * - `link(tagged_in, manual)` files it like any note; `link(derived_from, ai)`
 *   is provenance. Source and target may be the same record: two rows.
 * - `activity(note.created)` has the record as subject, as `createNoteProgram`.
 * `recordId` and `sourceId` are canonical; the caller follows merges.
 */
export async function writeSuggestedNoteInTx(
  tx: Tx,
  input: {
    payload: NotePayload
    recordId: string
    sourceId: string
    actorId: string
  },
): Promise<{ noteId: string }> {
  const { payload, recordId, sourceId, actorId } = input
  const body = noteBodyFromMarkdown(payload.markdown)

  const ent = (
    await tx
      .insert(entity)
      .values({
        kind: 'note',
        canonicalName: payload.title,
        createdBy: actorId,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('note entity insert returned no row')

  await tx.insert(note).values({
    entityId: ent.id,
    authorId: actorId,
    title: payload.title,
    kind: 'note',
    visibility: 'shared',
    bodyJson: body.bodyJson,
    bodyMd: body.bodyMd,
  })

  await tx.insert(link).values([
    {
      fromEntityId: ent.id,
      toEntityId: recordId,
      relation: 'tagged_in',
      source: 'manual',
      createdBy: actorId,
    },
    {
      fromEntityId: ent.id,
      toEntityId: sourceId,
      relation: 'derived_from',
      source: 'ai',
      createdBy: actorId,
    },
  ])

  await tx.insert(activity).values({
    actorId,
    verb: 'note.created',
    subjectEntityId: recordId,
    objectEntityId: ent.id,
  })

  return { noteId: ent.id }
}
