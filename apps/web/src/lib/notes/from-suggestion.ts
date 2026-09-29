import { entity, link, note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { NotePayload } from '@spaces/core/ai/note'
import type { Tx } from '@spaces/core/writes/attributes/values'
import { noteBodyFromMarkdown } from './markdown-blocks'

/**
 * A note written from the server with a body (SPA-66) — the path
 * `createNote` never had: it writes an empty Untitled note and leaves the
 * body to the editor, which is the only thing that has ever produced
 * `body_json`. Accepting a `suggestion(kind: 'note')` writes here, inside
 * the accept's transaction (`acceptProgram` in `lib/ai/propose.ts`), so the
 * note, its edges and the suggestion's flip commit together or not at all.
 *
 * What it writes, and why each:
 *
 * - `entity(kind: note)` + `note` — the **accepter** as `created_by` and
 *   `author_id` (spec §3: the person who decided is the actor), kind `note`,
 *   visibility `shared`. `body_json` and `body_md` from one markdown source,
 *   `body_md` serialized from the blocks (`markdown-blocks.ts`), so the
 *   editor and search read the same note.
 * - `link(note → record, tagged_in)` — **filed** against the record, the
 *   stamp `fileNoteAgainst` and "Note about this" write (`source: manual`),
 *   so a summary sits in the record's "Filed here" lane like any other note.
 * - `link(note → source, derived_from)` — provenance: the document (or the
 *   record) it was drafted from, stamped `source: ai` because a model drew
 *   it. `created_by` still names the accepter. A record's own summary has
 *   the record as both source and filing target: two relations, two rows,
 *   which the edge index's `(from, to, relation, attr_slug)` key allows.
 * - `activity(note.created)` — subject the record, object the note: the
 *   shape `createNoteProgram` writes when a note is born on a record, so the
 *   record's timeline reads it with no new rule.
 *
 * `recordId` and `sourceId` are canonical — the caller follows merges.
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
