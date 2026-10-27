import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { chunk, entity, link, note, view } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  getRegistryByObjectId,
  setValues,
} from '@spaces/core/writes/attributes/values'
import { objectIdForKindAsync } from '@spaces/core/writes/attributes/objects'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  PREVIEW_FIELDS,
  objectPreviewProgram,
  passagePreviewProgram,
  recordPreviewProgram,
} from './preview'

/**
 * Cmd-K's preview pane reads. A record's fields are its filled
 * attributes only, at most six; an object's views carry the chips' counts;
 * a passage's page holds its chunks with the matched one marked, and a
 * note the reader may not read answers nothing.
 */

const reader = { id: FIXTURE_ACTOR.id }
const NOW = new Date('2026-10-10T12:00:00Z')

async function company(name: string, domain: string) {
  const co = await resolveEntity({
    kind: 'company',
    name,
    keys: { domain },
    source: { class: 'manual' },
  })
  return co.entityId
}

describe('a record preview', () => {
  it('lists the filled attributes in registry order, never an empty one, and the head’s readouts', async () => {
    const id = await company('Flent', 'flent.example')
    await setValues({
      entityId: id,
      patch: {
        description: 'Managed rentals',
        location: 'Bengaluru, India',
        founded_year: 2021,
      },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    })

    const preview = await Effect.runPromise(
      recordPreviewProgram(reader, id, NOW),
    )
    expect(preview).toMatchObject({ id, kind: 'company', name: 'Flent' })
    expect(preview.singular).toBe('Company')
    const slugs = preview.fields.map((f) => f.slug)
    expect(slugs).toEqual(
      expect.arrayContaining(['description', 'location', 'founded_year']),
    )
    // Empty attributes are not listed.
    expect(slugs).not.toContain('business_model')
    expect(slugs).not.toContain('funding_stage')
    expect(preview.fields.every((f) => f.value !== '')).toBe(true)
    expect(preview.fields.find((f) => f.slug === 'location')).toMatchObject({
      label: 'Location',
      value: 'Bengaluru, India',
    })
    expect(preview.readouts).toMatchObject({
      kind: 'company',
      readouts: { today: '2026-10-10', lastContact: null, moving30: 0 },
    })
    // The domain heads the pane; the grid does not repeat it.
    expect(preview.domain).toBe('flent.example')
    expect(slugs).not.toContain('domains')
    expect(preview.stages).toBeNull()
  })

  it('stops at six, in registry order', async () => {
    const id = await company('Varda', 'varda.example')
    const founder = await resolveEntity({
      kind: 'person',
      name: 'Will Bruey',
      keys: { email: 'will@varda.example' },
      source: { class: 'manual' },
    })
    const registry = await getRegistryByObjectId(
      await objectIdForKindAsync('company'),
    )
    const stage = registry
      .find((d) => d.slug === 'funding_stage')
      ?.options.options?.at(0)
    if (!stage) throw new Error('no funding stage option')
    await setValues({
      entityId: id,
      patch: {
        description: 'In-space manufacturing',
        funding_stage: stage.id,
        location: 'El Segundo, CA',
        founded_year: 2021,
        linkedin: 'https://linkedin.com/company/varda',
        founders: [founder.entityId],
      },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    })
    const preview = await Effect.runPromise(
      recordPreviewProgram(reader, id, NOW),
    )
    // Seven are filled (domains too); the six first in the registry show.
    expect(preview.fields.map((f) => f.slug)).toEqual([
      'description',
      'funding_stage',
      'location',
      'founded_year',
      'linkedin',
      'founders',
    ])
    expect(preview.fields).toHaveLength(PREVIEW_FIELDS)
    expect(preview.fields.find((f) => f.slug === 'funding_stage')).toEqual({
      slug: 'funding_stage',
      label: 'Funding stage',
      value: stage.label,
      display: 'badge',
      option: stage,
      index: 0,
    })
    // A reference prints the record's name, as the assembler renders it.
    expect(preview.fields.find((f) => f.slug === 'founders')?.value).toBe(
      'Will Bruey',
    )
  })
})

describe('a deal preview', () => {
  it('carries its live stages with the current one, and prints money as money', async () => {
    const objectId = await objectIdForKindAsync('deal')
    const row = (
      await db
        .insert(entity)
        .values({ kind: 'deal', canonicalName: 'Flent — Seed', objectId })
        .returning({ id: entity.id })
    ).at(0)
    if (!row) throw new Error('entity insert returned nothing')
    const registry = await getRegistryByObjectId(objectId)
    const options = registry.find((d) => d.slug === 'stage')?.options.options
    const second = options?.at(1)
    if (!options || !second) throw new Error('no stage options')
    await setValues({
      entityId: row.id,
      patch: { stage: second.id, value: 1500000 },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    })
    const preview = await Effect.runPromise(
      recordPreviewProgram(reader, row.id, NOW),
    )
    expect(preview.stages).toEqual({
      current: second.id,
      options: options.filter((o) => o.archived !== true),
    })
    expect(preview.fields.find((f) => f.slug === 'stage')).toMatchObject({
      display: 'badge',
      index: 1,
    })
    expect(preview.fields.find((f) => f.slug === 'value')?.display).toBe(
      'money',
    )
    expect(preview.domain).toBeNull()
  })
})

describe('an object preview', () => {
  it('carries the list’s record total and the saved views with the chips’ counts', async () => {
    const objectId = await objectIdForKindAsync('company')
    const a = await company('Alpha', 'alpha.example')
    await company('Beta', 'beta.example')
    await setValues({
      entityId: a,
      patch: { location: 'Pune' },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    })
    await db.insert(view).values([
      {
        surface: 'object',
        objectId,
        name: 'In Pune',
        filter: [{ slug: 'location', op: 'is', value: 'Pune' }],
        visibility: 'shared',
        createdBy: FIXTURE_ACTOR.id,
      },
      {
        surface: 'object',
        objectId,
        name: 'Everything',
        filter: [],
        visibility: 'shared',
        createdBy: FIXTURE_ACTOR.id,
      },
    ])

    // Earlier tests in this file left their companies too.
    const companies = await db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.kind, 'company'))
    const preview = await Effect.runPromise(
      objectPreviewProgram(reader, 'companies'),
    )
    expect(preview).toMatchObject({
      slug: 'companies',
      path: '/companies',
      total: companies.length,
    })
    expect(
      preview?.views.map((v) => [v.name, v.count, v.href.split('?')[0]]),
    ).toEqual([
      ['Everything', companies.length, '/companies'],
      ['In Pune', 1, '/companies'],
    ])
  })

  it('answers null for an object that is not there', async () => {
    const preview = await Effect.runPromise(
      objectPreviewProgram(reader, 'no-such-object'),
    )
    expect(preview).toBeNull()
  })
})

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

describe('a passage preview', () => {
  it('shows its page, the matched chunk set off, and how many pages the file has', async () => {
    const deck = await entityOf('document', 'flent-seed-deck.pdf')
    await db.insert(chunk).values([
      {
        entityId: deck,
        sourceKind: 'document',
        idx: 0,
        text: 'Cover',
        page: 1,
      },
      {
        entityId: deck,
        sourceKind: 'document',
        idx: 1,
        text: 'Bengaluru and Pune, FY22 – FY26E.',
        page: 5,
      },
      {
        entityId: deck,
        sourceKind: 'document',
        idx: 2,
        text: '12,400 homes by Q4 FY26,\n  up 3.2× in two years.',
        page: 5,
      },
      {
        entityId: deck,
        sourceKind: 'document',
        idx: 3,
        text: 'Team',
        page: 14,
      },
    ])
    const preview = await Effect.runPromise(
      passagePreviewProgram(FIXTURE_ACTOR.id, {
        id: deck,
        page: 5,
        snippet: '12,400 homes by Q4 FY26, up 3.2× in two years.',
      }),
    )
    expect(preview).toEqual({
      page: 5,
      pages: 14,
      on: null,
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      parts: [
        { text: 'Bengaluru and Pune, FY22 – FY26E.', matched: false },
        {
          text: '12,400 homes by Q4 FY26,\n  up 3.2× in two years.',
          matched: true,
        },
      ],
    })
  })

  it('answers nothing from a note the reader may not read', async () => {
    await db
      .insert(user)
      .values({ id: 'ask4-other', name: 'Other', email: 'ask4@spaces.test' })
    const id = await entityOf('note', 'Private doubts')
    await db.insert(note).values({
      entityId: id,
      title: 'Private doubts',
      bodyMd: 'the homes number is ops-led',
      kind: 'note',
      authorId: 'ask4-other',
      visibility: 'private',
    })
    await db.insert(chunk).values({
      entityId: id,
      sourceKind: 'note',
      idx: 0,
      text: 'the homes number is ops-led',
    })
    const preview = await Effect.runPromise(
      passagePreviewProgram(FIXTURE_ACTOR.id, {
        id,
        page: null,
        snippet: 'the homes number is ops-led',
      }),
    )
    expect(preview.parts).toEqual([])
    // Nor where it lives, nor when.
    expect(preview.on).toBeNull()
    expect(preview.day).toBeNull()
  })

  it('names the record a note is filed on and the note’s last edit', async () => {
    const co = await company('Halcyon', 'halcyon.example')
    const id = await entityOf('note', 'IC call')
    await db.insert(note).values({
      entityId: id,
      title: 'IC call',
      bodyMd: 'storage at grid scale',
      kind: 'note',
      authorId: FIXTURE_ACTOR.id,
      updatedAt: new Date('2026-10-04T09:30:00Z'),
    })
    await db
      .insert(link)
      .values({ fromEntityId: id, toEntityId: co, relation: 'tagged_in' })
    await db.insert(chunk).values({
      entityId: id,
      sourceKind: 'note',
      idx: 0,
      text: 'storage at grid scale',
    })
    const preview = await Effect.runPromise(
      passagePreviewProgram(FIXTURE_ACTOR.id, {
        id,
        page: null,
        snippet: 'storage at grid scale',
      }),
    )
    expect(preview.on).toMatchObject({
      id: co,
      kind: 'company',
      name: 'Halcyon',
    })
    expect(preview.day).toBe('2026-10-04T09:30:00.000Z')
  })
})
