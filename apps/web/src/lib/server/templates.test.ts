import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { NoteBody } from '@spaces/db/schema/kinds'

/**
 * Note templates carry a kind, against the test database.
 * - `note.kind` stays at three because genres like "IC memo" are templates
 *   that set title, structure and kind; capture and stamp must carry the kind.
 * - A template with no stored kind (nothing was backfilled) must still stamp.
 * - A template is config, not an entity: stamping one materialises no `link`
 *   row, because mentions are stripped at capture.
 *
 * `captureNoteTemplate` / `stampNoteTemplate` rather than the server fns:
 * `requireUser` reads a request the suite cannot build. Imports are dynamic:
 * `@spaces/db` builds its pool from `DATABASE_URL` at import time and
 * `vitest.setup.ts` rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

/** One note with a kind and a body — everything else is default. */
async function makeNote(opts: {
  tag: string
  authorId: string
  kind: 'note' | 'memo' | 'scratch'
  bodyJson?: NoteBody
}): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, note } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({
      kind: 'note',
      canonicalName: `Tpl ${opts.tag}`,
      createdBy: opts.authorId,
    })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: ent.id,
    authorId: opts.authorId,
    title: `Tpl ${opts.tag}`,
    kind: opts.kind,
    bodyJson: opts.bodyJson ?? [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Thesis', styles: {} }],
      },
    ],
    bodyMd: 'Thesis',
  })
  return ent.id
}

/** The stamped note's row, as the app would read it back. */
async function readNote(noteId: string) {
  const { db } = await import('@spaces/db')
  const { note } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const row = (
    await db
      .select({
        title: note.title,
        kind: note.kind,
        bodyJson: note.bodyJson,
      })
      .from(note)
      .where(eq(note.entityId, noteId))
  ).at(0)
  expect(row).toBeTruthy()
  return row
}

async function readTemplate(templateId: string) {
  const { db } = await import('@spaces/db')
  const { template } = await import('@spaces/db/schema/templates')
  const { eq } = await import('drizzle-orm')
  const row = (
    await db.select().from(template).where(eq(template.id, templateId))
  ).at(0)
  expect(row).toBeTruthy()
  return row
}

describe('note template kind', () => {
  it('captures the source note’s kind and stamps a note of that kind', async () => {
    const { captureNoteTemplate, stampNoteTemplate } =
      await import('#/lib/notes/templates')
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const memoId = await makeNote({ tag, authorId: me, kind: 'memo' })

    const { id: templateId } = await captureNoteTemplate(me, {
      noteId: memoId,
      name: `IC memo ${tag}`,
    })
    expect((await readTemplate(templateId))?.noteKind).toBe('memo')

    const { id: stampedId } = await stampNoteTemplate(me, { templateId })
    const stamped = await readNote(stampedId)
    expect(stamped?.kind).toBe('memo')
    // The template's name is the new note's title: the third thing a genre
    // template sets.
    expect(stamped?.title).toBe(`IC memo ${tag}`)
  })

  it('captures scratch and plain note the same way', async () => {
    const { captureNoteTemplate, stampNoteTemplate } =
      await import('#/lib/notes/templates')
    const me = await actorId()
    for (const kind of ['note', 'scratch'] as const) {
      const tag = randomUUID().slice(0, 8)
      const sourceId = await makeNote({ tag, authorId: me, kind })
      const { id: templateId } = await captureNoteTemplate(me, {
        noteId: sourceId,
        name: `${kind} ${tag}`,
      })
      expect((await readTemplate(templateId))?.noteKind).toBe(kind)
      const { id: stampedId } = await stampNoteTemplate(me, { templateId })
      expect((await readNote(stampedId))?.kind).toBe(kind)
    }
  })

  it('stamps a plain note from a template saved before the column', async () => {
    const { db } = await import('@spaces/db')
    const { template } = await import('@spaces/db/schema/templates')
    const { stampNoteTemplate } = await import('#/lib/notes/templates')
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    // A row inserted without note_kind, as a template saved before the
    // column existed sits in the database. No backfill ran.
    const [legacy] = await db
      .insert(template)
      .values({
        kind: 'note',
        name: `Legacy ${tag}`,
        body: [{ type: 'paragraph', content: [] }],
        createdBy: me,
      })
      .returning({ id: template.id, noteKind: template.noteKind })
    expect(legacy.noteKind).toBeNull()

    const { id } = await stampNoteTemplate(me, { templateId: legacy.id })
    expect((await readNote(id))?.kind).toBe('note')
  })

  it('stamps a copy of the body and materialises no link row', async () => {
    const { db } = await import('@spaces/db')
    const { company, entity, link } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { captureNoteTemplate, stampNoteTemplate } =
      await import('#/lib/notes/templates')
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const [target] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `Kestrel ${tag}` })
      .returning({ id: entity.id })
    await db.insert(company).values({ entityId: target.id })

    const sourceId = await makeNote({
      tag,
      authorId: me,
      kind: 'memo',
      bodyJson: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              props: {
                entityId: target.id,
                label: `Kestrel ${tag}`,
                kind: 'company',
                objectSlug: '',
              },
            },
            { type: 'text', text: ' — thesis', styles: {} },
          ],
        },
      ],
    })

    const { id: templateId } = await captureNoteTemplate(me, {
      noteId: sourceId,
      name: `Debrief ${tag}`,
    })
    // Mentions are stripped to their labels at capture — the stored body
    // holds no entity id, so a stamp has nothing to link to.
    const stored = JSON.stringify((await readTemplate(templateId))?.body)
    expect(stored).not.toContain(target.id)
    expect(stored).toContain(`Kestrel ${tag}`)

    const { id: stampedId } = await stampNoteTemplate(me, { templateId })
    const stamped = await readNote(stampedId)
    expect(JSON.stringify(stamped?.bodyJson)).toBe(stored)

    const edges = await db
      .select({ relation: link.relation })
      .from(link)
      .where(eq(link.fromEntityId, stampedId))
    expect(edges).toEqual([])
  })
})
