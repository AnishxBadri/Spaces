import { inArray } from 'drizzle-orm'
import {
  interaction,
  interactionDocument,
  interactionEntity,
  interactionNote,
} from '@spaces/db/schema'
import type { Tx } from '../entities/resolve'
import { recomputeInteractionStats } from './stats'

/**
 * Interactions taken out of the graph, inside the caller's transaction:
 * their edges, their artifact rows and the rows themselves, the stats of
 * every entity they touched rebuilt in the same transaction.
 * - Answers the body notes the rows held, and the notes they carried beyond
 *   it (`interaction_note`). The caller deletes those through
 *   `deleteEntityProgram` once this commits — a note is an entity, and the
 *   registry walk is the only delete that cannot forget one of its rows.
 * - The documents an artifact row named stay: a file on a company outlives
 *   the email it arrived on.
 * - For mail a connection's exclude list now names, and a call a recorder's
 *   removed note had born; there is no manual delete of an interaction.
 */
export async function removeInteractions(
  tx: Tx,
  ids: ReadonlyArray<string>,
): Promise<{ readonly removed: number; readonly noteIds: Array<string> }> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return { removed: 0, noteIds: [] }
  const rows = await tx
    .select({ id: interaction.id, noteId: interaction.noteId })
    .from(interaction)
    .where(inArray(interaction.id, wanted))
    .for('update')
  if (rows.length === 0) return { removed: 0, noteIds: [] }
  const held = rows.map((r) => r.id)
  const edges = await tx
    .delete(interactionEntity)
    .where(inArray(interactionEntity.interactionId, held))
    .returning({ entityId: interactionEntity.entityId })
  await recomputeInteractionStats(
    tx,
    edges.map((e) => e.entityId),
  )
  await tx
    .delete(interactionDocument)
    .where(inArray(interactionDocument.interactionId, held))
  const carried = await tx
    .delete(interactionNote)
    .where(inArray(interactionNote.interactionId, held))
    .returning({ noteId: interactionNote.noteId })
  await tx.delete(interaction).where(inArray(interaction.id, held))
  return {
    removed: rows.length,
    noteIds: [
      ...rows.flatMap((r) => (r.noteId === null ? [] : [r.noteId])),
      ...carried.map((c) => c.noteId),
    ],
  }
}
