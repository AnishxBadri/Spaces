import { randomUUID } from 'node:crypto'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { attribute, attributeEvent, entity, link } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '../entities/resolve'
import { createAttributeProgram } from './create'
import { createObjectProgram, createRecordProgram } from './object-registry'
import { objectIdForKindAsync } from './objects'
import { createRelationshipProgram } from './relationship'
import {
  AttributeConfigRejected,
  AttributeNarrowingRefused,
  SystemAttributeLocked,
  updateAttributeProgram,
} from './update'
import { setValues } from './values'
import type { CreateAttributeInput } from './create'
import type { Cardinality } from '../../attributes/relationship'

/** Edits widen only; system attributes are never archived. */

const actor = { type: 'user', id: FIXTURE_ACTOR.id } as const
const tag = () => randomUUID().slice(0, 8)

const company = async (name: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name: `${name} ${tag()}`,
      source: { class: 'manual' },
    })
  ).entityId

const person = async (name: string) =>
  (
    await resolveEntity({
      kind: 'person',
      name: `${name} ${tag()}`,
      source: { class: 'manual' },
    })
  ).entityId

const userAttr = (
  input: Omit<CreateAttributeInput, 'createdBy' | 'objectKind'> & {
    objectKind?: 'company' | 'person' | 'deal'
  },
) =>
  Effect.runPromise(
    createAttributeProgram({
      objectKind: 'company',
      ...input,
      name: `${input.name} ${tag()}`,
      createdBy: FIXTURE_ACTOR.id,
    }),
  )

const attr = async (id: string) => {
  const row = (
    await db.select().from(attribute).where(eq(attribute.id, id))
  ).at(0)
  if (!row) throw new Error(`no attribute ${id}`)
  return row
}

const systemAttr = async (
  kind: 'company' | 'person' | 'deal',
  slug: string,
) => {
  const objectId = await objectIdForKindAsync(kind)
  const row = (
    await db
      .select()
      .from(attribute)
      .where(and(eq(attribute.objectId, objectId), eq(attribute.slug, slug)))
  ).at(0)
  if (!row) throw new Error(`no ${kind}.${slug}`)
  return row
}

const valuesOf = async (id: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)?.values ?? {}

/** Per-record events on a slug: the ones a widening must not add to. */
const recordEventCount = async (slug: string) =>
  (
    await db
      .select({ id: attributeEvent.id })
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.attrSlug, slug),
          isNotNull(attributeEvent.entityId),
        ),
      )
  ).length

const attributeEvents = (attributeId: string) =>
  db
    .select()
    .from(attributeEvent)
    .where(eq(attributeEvent.attributeId, attributeId))

const update = (patch: Parameters<typeof updateAttributeProgram>[0]) =>
  Effect.runPromise(updateAttributeProgram(patch, actor))
const refused = (patch: Parameters<typeof updateAttributeProgram>[0]) =>
  Effect.runPromise(Effect.flip(updateAttributeProgram(patch)))

describe('widening (D69)', () => {
  it('widens a select to a multi-select, wrapping every stored value in one statement', async () => {
    // Born before the attribute, so its default fills none of them.
    const [a, b, empty] = [
      await company('Wa'),
      await company('Wb'),
      await company('Wc'),
    ]
    const stage = await userAttr({
      name: 'Round',
      type: 'select',
      options: [{ label: 'Seed' }, { label: 'Series A' }],
      default: 'seed',
    })
    await setValues({ entityId: a, patch: { [stage.slug]: 'seed' }, actor })
    await setValues({ entityId: b, patch: { [stage.slug]: 'series_a' }, actor })
    const before = await recordEventCount(stage.slug)

    await update({ id: stage.id, multi: true })

    const row = await attr(stage.id)
    expect(row.type).toBe('multi_select')
    expect(row.options.default).toEqual(['seed'])
    expect((await valuesOf(a))[stage.slug]).toEqual(['seed'])
    expect((await valuesOf(b))[stage.slug]).toEqual(['series_a'])
    expect(stage.slug in (await valuesOf(empty))).toBe(false)
    // One event on the attribute, none per record.
    expect(await recordEventCount(stage.slug)).toBe(before)
    const events = await attributeEvents(stage.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      entityId: null,
      attrSlug: stage.slug,
      from: { type: 'select', multi: false },
      to: { type: 'multi_select', multi: true, records: 2 },
      actorType: 'user',
      actorId: FIXTURE_ACTOR.id,
    })

    // The widened attribute takes lists through the one write path.
    await setValues({
      entityId: a,
      patch: { [stage.slug]: ['seed', 'series_a'] },
      actor,
    })
    expect((await valuesOf(a))[stage.slug]).toEqual(['seed', 'series_a'])
    // Widening again is a no-op, not a second wrap or a second event.
    await update({ id: stage.id, multi: true })
    expect((await valuesOf(b))[stage.slug]).toEqual(['series_a'])
    expect(await attributeEvents(stage.id)).toHaveLength(1)
  })

  it('widens a single reference, keeping its links', async () => {
    const lead = await userAttr({
      name: 'Lead investor',
      type: 'record_reference',
      config: { targetKind: 'person', multi: false },
    })
    const co = await company('Lead co')
    const p = await person('Lead')
    await setValues({ entityId: co, patch: { [lead.slug]: p }, actor })

    await update({ id: lead.id, multi: true })

    const row = await attr(lead.id)
    expect(row.type).toBe('record_reference')
    expect(row.options.multi).toBe(true)
    expect((await valuesOf(co))[lead.slug]).toEqual([p])
    const links = await db
      .select()
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, co),
          eq(link.toEntityId, p),
          eq(link.attrSlug, lead.slug),
        ),
      )
    expect(links).toHaveLength(1)
  })

  it('refuses narrowing, naming the attribute, and writes nothing', async () => {
    const tags = await userAttr({
      name: 'Themes',
      type: 'multi_select',
      options: [{ label: 'Climate' }, { label: 'Fintech' }],
    })
    const co = await company('Narrow')
    await setValues({
      entityId: co,
      patch: { [tags.slug]: ['climate', 'fintech'] },
      actor,
    })

    const err = await refused({ id: tags.id, multi: false })
    expect(err).toBeInstanceOf(AttributeNarrowingRefused)
    if (err instanceof AttributeNarrowingRefused) {
      const row = await attr(tags.id)
      expect(err.attribute).toBe(row.name)
      expect(err.message).toContain(row.name)
    }
    expect((await attr(tags.id)).type).toBe('multi_select')
    expect((await valuesOf(co))[tags.slug]).toEqual(['climate', 'fintech'])
    expect(await attributeEvents(tags.id)).toHaveLength(0)

    const refs = await userAttr({
      name: 'Advisors',
      type: 'record_reference',
      config: { targetKind: 'person', multi: true },
    })
    expect(await refused({ id: refs.id, multi: false })).toBeInstanceOf(
      AttributeNarrowingRefused,
    )
    expect((await attr(refs.id)).options.multi).toBe(true)
  })

  it('refuses a type with no list shape, and a system attribute', async () => {
    const amount = await userAttr({ name: 'Ticket', type: 'number' })
    expect(await refused({ id: amount.id, multi: true })).toBeInstanceOf(
      AttributeConfigRejected,
    )
    expect((await attr(amount.id)).type).toBe('number')

    const dealCompany = await systemAttr('deal', 'company')
    expect(await refused({ id: dealCompany.id, multi: true })).toBeInstanceOf(
      SystemAttributeLocked,
    )
    expect((await attr(dealCompany.id)).options.multi).not.toBe(true)
  })
})

describe('relationship widening (D69)', () => {
  const objects = async () => {
    const make = (plural: string) =>
      Effect.runPromise(
        createObjectProgram({
          singular: plural.slice(0, -1),
          plural: `${plural} ${tag()}`,
          createdBy: FIXTURE_ACTOR.id,
        }),
      )
    return { a: await make('Funds'), b: await make('Managers') }
  }
  const relate = (a: string, b: string, cardinality: Cardinality) =>
    Effect.runPromise(
      createRelationshipProgram({
        objectId: a,
        name: `Manager ${tag()}`,
        targetObjectId: b,
        inverseName: `Funds ${tag()}`,
        cardinality,
        createdBy: FIXTURE_ACTOR.id,
      }),
    )
  const record = async (objectId: string) =>
    (
      await Effect.runPromise(
        createRecordProgram({
          objectId,
          name: `Rec ${tag()}`,
          actor,
          source: 'manual',
        }),
      )
    ).id

  it('widens an N:1 owner to N:N on both halves and wraps its values', async () => {
    const { a, b } = await objects()
    const pair = await relate(a.id, b.id, 'N:1')
    const fund = await record(a.id)
    const manager = await record(b.id)
    await setValues({
      entityId: fund,
      patch: { [pair.a.slug]: manager },
      actor,
    })

    await update({ id: pair.a.id, multi: true })

    const owner = await attr(pair.a.id)
    const inverse = await attr(pair.b.id)
    expect(owner.options).toMatchObject({ cardinality: 'N:N', multi: true })
    expect(inverse.options).toMatchObject({ cardinality: 'N:N', multi: true })
    expect((await valuesOf(fund))[pair.a.slug]).toEqual([manager])
    expect((await attributeEvents(pair.a.id)).map((e) => e.to)).toEqual([
      { type: 'record_reference', multi: true, cardinality: 'N:N', records: 1 },
    ])
  })

  it('widens a 1:1 owner to 1:N, its derived half keeping one, and holds each target once', async () => {
    const { a, b } = await objects()
    const pair = await relate(a.id, b.id, '1:1')
    const [fund, other] = [await record(a.id), await record(a.id)]
    const [m1, m2] = [await record(b.id), await record(b.id)]
    await setValues({ entityId: fund, patch: { [pair.a.slug]: m1 }, actor })

    await update({ id: pair.a.id, multi: true })
    expect((await attr(pair.a.id)).options).toMatchObject({
      cardinality: '1:N',
      multi: true,
    })
    expect((await attr(pair.b.id)).options).toMatchObject({
      cardinality: 'N:1',
      multi: false,
      derived: true,
    })
    expect((await valuesOf(fund))[pair.a.slug]).toEqual([m1])

    await setValues({
      entityId: fund,
      patch: { [pair.a.slug]: [m1, m2] },
      actor,
    })
    // A manager is still held by one fund at a time.
    await expect(
      setValues({ entityId: other, patch: { [pair.a.slug]: [m1] }, actor }),
    ).rejects.toThrow(/already held by/)
    expect((await valuesOf(other))[pair.a.slug]).toBeUndefined()
  })

  it('widens a 1:1 from its derived half: the derived side holds many', async () => {
    const { a, b } = await objects()
    const pair = await relate(a.id, b.id, '1:1')
    await update({ id: pair.b.id, multi: true })
    expect((await attr(pair.b.id)).options).toMatchObject({
      cardinality: '1:N',
      multi: true,
      derived: true,
    })
    expect((await attr(pair.a.id)).options).toMatchObject({
      cardinality: 'N:1',
      multi: false,
    })
  })
})

describe('a write racing a widening (D69)', () => {
  /** Backends of this database waiting on a lock. */
  const lockWaiters = async () => {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    )
    return rows.rows.at(0)?.n ?? 0
  }
  const until = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await ok()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('timed out waiting on locks')
  }

  it('cannot commit a widening between a write reading its shape and writing the row', async () => {
    const co = await company('Race')
    const round = await userAttr({
      name: 'Race round',
      type: 'select',
      options: [{ label: 'Seed' }],
    })
    // Hold the record so the write stops after reading its definitions.
    let release = () => {}
    const held = new Promise<void>((r) => (release = r))
    const holder = db.transaction(async (tx) => {
      await tx.select().from(entity).where(eq(entity.id, co)).for('update')
      await held
    })
    await until(async () => (await lockWaiters()) === 0)

    const write = setValues({
      entityId: co,
      patch: { [round.slug]: 'seed' },
      actor,
    })
    await until(async () => (await lockWaiters()) === 1)
    let widened = false
    const widen = update({ id: round.id, multi: true }).then(() => {
      widened = true
    })
    await until(async () => (await lockWaiters()) === 2)
    // The widening waits on the write's hold on the definitions.
    expect(widened).toBe(false)

    release()
    await holder
    await write
    await widen
    expect((await attr(round.id)).type).toBe('multi_select')
    expect((await valuesOf(co))[round.slug]).toEqual(['seed'])
  })
})

describe('archiving (D69)', () => {
  it('refuses a system attribute and archives a user one', async () => {
    const stage = await systemAttr('deal', 'stage')
    const err = await refused({ id: stage.id, archived: true })
    expect(err).toBeInstanceOf(SystemAttributeLocked)
    if (err instanceof SystemAttributeLocked)
      expect(err.message).toBe(
        `${stage.name} ships with Spaces and cannot be archived`,
      )
    expect((await attr(stage.id)).archived).toBe(false)

    const mine = await userAttr({ name: 'Notes', type: 'text' })
    await update({ id: mine.id, archived: true })
    expect((await attr(mine.id)).archived).toBe(true)
    await update({ id: mine.id, archived: false })
    expect((await attr(mine.id)).archived).toBe(false)
  })
})

describe('attribute_event subject', () => {
  it('holds exactly one of a record and an attribute', async () => {
    const mine = await userAttr({ name: 'Subject', type: 'text' })
    const co = await company('Subject')
    const row = { attrSlug: mine.slug, actorType: 'system' as const }
    await expect(db.insert(attributeEvent).values(row)).rejects.toThrow()
    await expect(
      db
        .insert(attributeEvent)
        .values({ ...row, entityId: co, attributeId: mine.id }),
    ).rejects.toThrow()
    await db.insert(attributeEvent).values({ ...row, attributeId: mine.id })
    expect(await attributeEvents(mine.id)).toHaveLength(1)
  })
})
