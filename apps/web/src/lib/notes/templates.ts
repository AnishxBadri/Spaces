import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { template } from '@spaces/db/schema/templates'
import { canRead } from '#/lib/notes/visibility'
import type { Json } from '#/lib/json'

/**
 * Note-template capture and stamp (SPA-131), minus the request context.
 *
 * Outside `lib/server/` because the suite drives these directly — the server
 * fns in `lib/server/templates.ts` are thin `requireUser` wrappers — and a
 * plain export from a `lib/server/*.ts` module keeps its imports alive in
 * the client bundle, which is how `canRead`'s neighbour `getRequest` used to
 * reach the browser (SPA-155).
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
 * Capture (SPA-131). A note template stamps a *genre*, not just a shape:
 * CONTEXT.md freezes `note.kind` at three precisely because "IC memo" and
 * "post-mortem" are templates that set title/structure/**kind**, so the
 * source note's current kind is captured alongside its body. Saving a memo
 * as a template records `note_kind = 'memo'`; nothing else about capture
 * changes — mentions are still stripped, and the body is still a copy.
 *
 * Split out of the server fn so the suite can drive it: `requireUser` reads
 * a request the tests have no way to build (the `entityContext` pattern in
 * `lib/inbox/context.ts`).
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
 * Stamp (SPA-131). The template's `note_kind` becomes the new note's kind,
 * so an IC-memo template stamps a memo and not a plain note. Null — every
 * template saved before the column, and there is deliberately no backfill —
 * falls through to the column default, which is what those templates have
 * always produced.
 *
 * Still copy-not-reference and still mention-free: the body was stripped at
 * capture, so no `link` row is materialised here and none ever was. That is
 * also why this does not route through `createNoteProgram` — see the note in
 * `lib/notes/create.ts`: that program's job is a note born *about* something,
 * with the filing and starter-mention rows that implies, and a template note
 * is born about nothing with a body it did not write.
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
