import { Effect } from 'effect'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  chunk,
  document,
  entity,
  interaction,
  interactionEntity,
  link,
  note,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { setValues } from '@spaces/core/writes/attributes/values'
import { ref } from '@spaces/core/context/ref'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { askRefPreviewProgram } from './ref-preview'

/**
 * A citation's hover: the passage a ref names, read as the reader. A file
 * chunk carries its page and the file's last page, a note its first chunk,
 * an interaction its body, an attribute its value — and whatever the reader
 * may not read answers nothing, not even where it lives.
 */

const OTHER = 'ask-ref-other'
const me = FIXTURE_ACTOR.id

const preview = (r: string, userId = me) =>
  Effect.runPromise(askRefPreviewProgram(userId, r))

async function entityOf(kind: 'document' | 'note', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  return row.id
}

async function company(name: string, domain: string) {
  const co = await resolveEntity({
    kind: 'company',
    name,
    keys: { domain },
    source: { class: 'manual' },
  })
  return co.entityId
}

async function deck(visibility: 'shared' | 'private', on: string) {
  const id = await entityOf('document', 'seed-deck.pdf')
  await db.insert(document).values({
    entityId: id,
    filename: 'seed-deck.pdf',
    visibility,
    authorId: OTHER,
  })
  await db
    .insert(link)
    .values({ fromEntityId: id, toEntityId: on, relation: 'tagged_in' })
  await db.insert(chunk).values([
    { entityId: id, sourceKind: 'document', idx: 0, text: 'Cover', page: 1 },
    {
      entityId: id,
      sourceKind: 'document',
      idx: 1,
      text: '12,400 homes by Q4 FY26.',
      page: 5,
    },
    { entityId: id, sourceKind: 'document', idx: 2, text: 'Team', page: 14 },
  ])
  return id
}

async function noteOf(visibility: 'shared' | 'private', authorId: string) {
  const id = await entityOf('note', 'IC call')
  await db.insert(note).values({
    entityId: id,
    title: 'IC call',
    bodyMd: 'Storage at grid scale.',
    kind: 'note',
    authorId,
    visibility,
    updatedAt: new Date('2026-10-02T09:30:00Z'),
  })
  await db.insert(chunk).values([
    { entityId: id, sourceKind: 'note', idx: 0, text: 'Storage at grid' },
    { entityId: id, sourceKind: 'note', idx: 1, text: 'scale.' },
  ])
  return id
}

beforeAll(async () => {
  await db
    .insert(user)
    .values({ id: OTHER, name: 'Other', email: 'ask-ref@spaces.test' })
})

describe('previewAskRef', () => {
  it('reads a file chunk with its page, the last page, the record it is on and its day', async () => {
    const co = await company('Flent', 'flent.example')
    const id = await deck('shared', co)
    expect(await preview(ref.doc(id, 1))).toEqual({
      kind: 'file',
      name: 'seed-deck.pdf',
      text: '12,400 homes by Q4 FY26.',
      page: 5,
      pages: 14,
      on: 'Flent',
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
  })

  it('answers nothing from a file private to someone else, nor where it lives', async () => {
    const co = await company('Halcyon', 'halcyon.example')
    const id = await deck('private', co)
    expect(await preview(ref.doc(id, 1))).toBeNull()
    // Its author reads it.
    expect((await preview(ref.doc(id, 1), OTHER))?.on).toBe('Halcyon')
  })

  it('reads a note’s first chunk, and nothing from someone else’s private note', async () => {
    const mine = await noteOf('private', me)
    expect(await preview(ref.note(mine))).toMatchObject({
      kind: 'note',
      name: 'IC call',
      text: 'Storage at grid',
      page: null,
      day: '2026-10-02T09:30:00.000Z',
    })
    const theirs = await noteOf('private', OTHER)
    expect(await preview(ref.note(theirs))).toBeNull()
    expect(await preview(ref.memo(theirs))).toBeNull()
  })

  it('reads an interaction’s body behind its note’s read policy', async () => {
    const co = await company('Keyhold', 'keyhold.example')
    const body = await noteOf('shared', me)
    const row = (
      await db
        .insert(interaction)
        .values({
          kind: 'call',
          subject: 'Intro call',
          noteId: body,
          occurredAt: new Date('2026-10-01T10:00:00Z'),
        })
        .returning({ id: interaction.id })
    ).at(0)
    if (!row) throw new Error('interaction insert returned nothing')
    await db
      .insert(interactionEntity)
      .values({ interactionId: row.id, entityId: co })
    expect(await preview(ref.interaction(row.id))).toMatchObject({
      kind: 'interaction',
      name: 'Intro call',
      text: 'Storage at grid scale.',
      on: 'Keyhold',
      day: '2026-10-01T10:00:00.000Z',
    })

    const hidden = await noteOf('private', OTHER)
    const quiet = (
      await db
        .insert(interaction)
        .values({
          kind: 'email',
          subject: 'Private',
          noteId: hidden,
          occurredAt: new Date('2026-10-01T10:00:00Z'),
        })
        .returning({ id: interaction.id })
    ).at(0)
    if (!quiet) throw new Error('interaction insert returned nothing')
    expect(await preview(ref.interaction(quiet.id))).toBeNull()
  })

  it('reads an attribute’s value on its record, with the day it last changed', async () => {
    const co = await company('Leasewise', 'leasewise.example')
    await setValues({
      entityId: co,
      patch: { location: 'Pune, India' },
      actor: { type: 'user', id: me },
    })
    const out = await preview(ref.attr(co, 'location'))
    expect(out).toMatchObject({
      kind: 'attribute',
      name: 'Location',
      text: 'Pune, India',
      on: 'Leasewise',
    })
    expect(out?.day).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await preview(ref.attr(co, 'founded_year'))).toBeNull()
  })

  it('answers nothing for a ref outside the grammar, or one that names nothing', async () => {
    expect(await preview('record:abc')).toBeNull()
    expect(await preview(ref.task('t1'))).toBeNull()
    expect(
      await preview(ref.doc('00000000-0000-4000-8000-000000000000', 0)),
    ).toBeNull()
    expect(await preview(ref.note('not-a-uuid'))).toBeNull()
  })
})
