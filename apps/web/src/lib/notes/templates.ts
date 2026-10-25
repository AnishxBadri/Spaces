import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { template } from '@spaces/db/schema/templates'
import { canRead } from '@spaces/core/read-policy'
import type { Json } from '@spaces/core/json'

/**
 * Note-template capture and stamp, minus the request context, so the suite
 * can drive them. Kept out of the server-fn modules: a plain export there
 * keeps its imports alive in the client bundle.
 */

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
export async function captureNoteTemplate(
  userId: string,
  input: { noteId: string; name: string },
): Promise<{ id: string }> {
  const row = (
    await db
      .select({
        bodyJson: note.bodyJson,
        kind: note.kind,
        authorId: note.authorId,
        visibility: note.visibility,
      })
      .from(note)
      .where(eq(note.entityId, input.noteId))
  ).at(0)
  if (!row || !canRead({ id: userId }, row)) throw new Error('Note not found')
  const body = stripMentions(row.bodyJson ?? [])
  const t = (
    await db
      .insert(template)
      .values({
        kind: 'note',
        noteKind: row.kind,
        name: input.name,
        body: body ?? [],
        createdBy: userId,
      })
      .returning({ id: template.id })
  ).at(0)
  if (!t) throw new Error('Template insert returned no row')
  return { id: t.id }
}

/**
 * Stamp. The template's `note_kind` becomes the new note's kind; null falls
 * through to the column default (deliberately no backfill).
 * - Copy, not reference, and mention-free: no `link` row is written.
 * - Not `createNoteProgram`: that writes a note born about something, with
 *   filing and starter-mention rows; a template note is about nothing.
 */
export async function stampNoteTemplate(
  userId: string,
  input: { templateId: string },
): Promise<{ id: string }> {
  const t = (
    await db
      .select()
      .from(template)
      .where(and(eq(template.id, input.templateId), eq(template.kind, 'note')))
  ).at(0)
  if (!t) throw new Error('Template not found')
  return db.transaction(async (tx) => {
    const ent = (
      await tx
        .insert(entity)
        .values({ kind: 'note', canonicalName: t.name, createdBy: userId })
        .returning({ id: entity.id })
    ).at(0)
    if (!ent) throw new Error('note entity insert returned no row')
    // Copy, not reference — divergence after stamping is the point.
    await tx.insert(note).values({
      entityId: ent.id,
      authorId: userId,
      title: t.name,
      ...(t.noteKind ? { kind: t.noteKind } : {}),
      bodyJson: Array.isArray(t.body) ? t.body : [],
      bodyMd: '',
    })
    await tx.insert(activity).values({
      actorId: userId,
      verb: 'note.created',
      subjectEntityId: ent.id,
    })
    return { id: ent.id }
  })
}
