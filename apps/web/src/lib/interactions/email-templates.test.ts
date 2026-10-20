import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { document, entity } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { template } from '@spaces/db/schema/templates'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { getDraftProgram, saveDraftProgram } from './email-drafts'
import {
  EmailTemplateNotFound,
  emailTemplateProgram,
  saveEmailTemplateProgram,
} from './email-templates'

/**
 * Email templates (D67): saved from a draft, listed by kind, applied into a
 * draft with subject, body and files — a file the member may not read is
 * left off.
 */

const ME = { id: FIXTURE_ACTOR.id }
const TEAMMATE = {
  id: 'member-teammate',
  name: 'Priya',
  email: 'priya@fund.example',
  emailVerified: true,
}

const run = <TValue, TError>(program: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(program)

const aDocument = async (
  name: string,
  privateTo: string | null = null,
): Promise<string> => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no document')
  await db.insert(document).values({
    entityId: ent.id,
    filename: name,
    kind: 'other',
    ...(privateTo === null
      ? {}
      : { visibility: 'private' as const, authorId: privateTo }),
  })
  return ent.id
}

beforeEach(async () => {
  await truncateAndReseed()
  await db.insert(user).values(TEAMMATE)
})

describe('email templates', () => {
  it('saves as the email kind and lists by it', async () => {
    const deck = await aDocument('deck.pdf')
    const { id } = await run(
      saveEmailTemplateProgram(ME, {
        name: 'Intro',
        subject: 'Intro: {{company.name}}',
        bodyMd: 'Hi {{name.first}},',
        attachments: [{ documentId: deck }],
      }),
    )
    const rows = await db
      .select()
      .from(template)
      .where(eq(template.kind, 'email'))
    expect(rows.map((r) => r.id)).toEqual([id])
    expect(rows[0]?.body).toEqual({
      subject: 'Intro: {{company.name}}',
      body_md: 'Hi {{name.first}},',
      attachments: [{ documentId: deck }],
    })
    expect(rows[0]?.suggestOn).toEqual([])
    const notes = await db
      .select()
      .from(template)
      .where(and(eq(template.kind, 'note'), eq(template.id, id)))
    expect(notes).toEqual([])
  })

  it('applies into a draft with its subject, body and files', async () => {
    const deck = await aDocument('deck.pdf')
    const memo = await aDocument('memo.pdf')
    const { id } = await run(
      saveEmailTemplateProgram(ME, {
        name: 'Intro',
        subject: 'Intro: {{company.name}}',
        bodyMd: 'Hi {{name.first}},\n\nThe deck is attached.',
        attachments: [{ documentId: deck }, { documentId: memo }],
      }),
    )
    const fill = await run(emailTemplateProgram(TEAMMATE, id))
    expect(fill).toEqual({
      subject: 'Intro: {{company.name}}',
      bodyMd: 'Hi {{name.first}},\n\nThe deck is attached.',
      attachments: [
        { documentId: deck, name: 'deck.pdf' },
        { documentId: memo, name: 'memo.pdf' },
      ],
    })

    const draftId = '00000000-0000-4000-8000-00000000f001'
    await run(
      saveDraftProgram(TEAMMATE, {
        id: draftId,
        mode: 'new',
        inReplyToId: null,
        to: [{ email: 'dana@flent.example' }],
        cc: [],
        bcc: [],
        subject: fill.subject,
        bodyMd: fill.bodyMd,
        attachments: fill.attachments.map((a) => ({
          documentId: a.documentId,
        })),
      }),
    )
    const draft = await run(getDraftProgram(TEAMMATE, draftId))
    expect(draft.subject).toBe(fill.subject)
    expect(draft.bodyMd).toBe(fill.bodyMd)
    expect(draft.attachments).toEqual(fill.attachments)
  })

  it('leaves off a file the member applying it may not read', async () => {
    const mine = await aDocument('term-sheet.pdf', ME.id)
    const shared = await aDocument('deck.pdf')
    const { id } = await run(
      saveEmailTemplateProgram(ME, {
        name: 'Follow-up',
        subject: 'Following up',
        bodyMd: 'Attached.',
        attachments: [{ documentId: mine }, { documentId: shared }],
      }),
    )
    const own = await run(emailTemplateProgram(ME, id))
    expect(own.attachments.map((a) => a.documentId)).toEqual([mine, shared])
    const theirs = await run(emailTemplateProgram(TEAMMATE, id))
    expect(theirs.attachments.map((a) => a.documentId)).toEqual([shared])
  })

  it('reads another kind of template, or an archived one, as missing', async () => {
    const note = (
      await db
        .insert(template)
        .values({ kind: 'note', name: 'Debrief', body: [], createdBy: ME.id })
        .returning({ id: template.id })
    ).at(0)
    if (!note) throw new Error('no template')
    const failure = await Effect.runPromise(
      Effect.flip(emailTemplateProgram(ME, note.id)),
    )
    expect(failure).toBeInstanceOf(EmailTemplateNotFound)

    const { id } = await run(
      saveEmailTemplateProgram(ME, {
        name: 'Old',
        subject: 's',
        bodyMd: 'b',
        attachments: [],
      }),
    )
    await db.update(template).set({ archived: true }).where(eq(template.id, id))
    const archived = await Effect.runPromise(
      Effect.flip(emailTemplateProgram(ME, id)),
    )
    expect(archived).toBeInstanceOf(EmailTemplateNotFound)
  })
})
