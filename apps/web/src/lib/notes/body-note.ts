import { entity, note } from '@spaces/db/schema'
import type { NoteBody } from '@spaces/db/schema/kinds'
import type { Tx } from '@spaces/core/writes/entities/resolve'

/**
 * The birth of an arrived message's body note (SPA-56; D30, D49), inside the
 * caller's transaction: the `note` entity and its `note` row, born `shared`
 * and filed against nothing.
 *
 * It lives here rather than in `lib/arrival/` because nothing under
 * `lib/arrival/` inserts into `entity` or `entity_alias` itself (SPA-86,
 * held by `lib/arrival/one-door.test.ts`): people and companies arrive
 * through `resolveEntity`, and the one other entity the lane writes — this
 * note — through this function. The rows are exactly what `file.ts` wrote
 * inline before; only their address moved.
 */
export type BodyNoteInput = {
  title: string
  bodyJson: NoteBody
  bodyMd: string
  authorId: string
  /** The integration row that wrote it — `source_ref` on the entity. */
  integrationId: string
}

export async function insertBodyNote(
  tx: Tx,
  input: BodyNoteInput,
): Promise<string> {
  const noteEntity = (
    await tx
      .insert(entity)
      .values({
        kind: 'note',
        canonicalName: input.title || 'Untitled',
        createdBy: input.authorId,
        sourceClass: 'integration',
        sourceRef: input.integrationId,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!noteEntity) throw new Error('note entity insert returned no row')
  await tx.insert(note).values({
    entityId: noteEntity.id,
    authorId: input.authorId,
    title: input.title,
    kind: 'note',
    bodyJson: input.bodyJson,
    bodyMd: input.bodyMd,
    visibility: 'shared',
  })
  return noteEntity.id
}
