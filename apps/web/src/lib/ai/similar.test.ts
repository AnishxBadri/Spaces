import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  chunk,
  entity,
  link,
  note,
  objectDef,
  workspace,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { PIN_DIMS } from '#/lib/ai/providers/embed/ids'
import { assembleProgram } from '@spaces/core/writes/context/assemble'
import type { AssembleResult } from '@spaces/core/writes/context/assemble'
import { resolveRefsProgram } from '@spaces/core/writes/context/names'
import { SIMILAR_TOP_N } from '@spaces/core/context/similar-lane'
import { ref } from '@spaces/core/context/ref'
import { SIMILAR_MAX_DISTANCE, SimilarLaneLive } from './similar'

/**
 * The judgment-memory lane (SPA-139). Chunks are written by hand with chosen
 * vectors, as `semantic-lane.test.ts` writes them: the company's own chunks
 * sit on axis 0, so the anchor (their mean) is axis 0, and every other
 * record's chunk sits at a chosen cosine distance from it — "nearest" is
 * decided by the fixture, not by a model. The pin is written straight into
 * `workspace.settings`; nothing here embeds.
 *
 * The file's database was truncated and reseeded before it was imported
 * (SPA-145), so these fixtures are the whole corpus.
 */

const ASOF = '2026-09-20T00:00:00Z'
const MODEL = 'text-embedding-3-small'

/** A 768-wide vector along `axis`, leaning `by` along `lean`. */
function toward(axis: number, lean?: { axis: number; by: number }) {
  const v = Array.from({ length: PIN_DIMS }, () => 0)
  v[axis] = 1
  if (lean) v[lean.axis] = lean.by
  return v
}

async function setPin(pinned: boolean) {
  const settings = pinned
    ? {
        embedding: {
          provider: 'openai',
          model: MODEL,
          dims: PIN_DIMS,
          pinned_at: '2026-09-01T00:00:00.000Z',
        },
      }
    : {}
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

async function objectId(slug: 'companies' | 'deals') {
  const row = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, slug))
  ).at(0)
  if (!row) throw new Error(`no ${slug} object`)
  return row.id
}

async function newRecord(
  kind: 'company' | 'deal',
  name: string,
  values: Record<string, string> = {},
) {
  const row = (
    await db
      .insert(entity)
      .values({
        kind,
        canonicalName: name,
        objectId: await objectId(kind === 'company' ? 'companies' : 'deals'),
        values,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  return row.id
}

/** A note filed (`tagged_in`) on `on`, with one chunk at `embedding`. */
async function filedNote(opts: {
  on: string
  title: string
  body: string
  authorId: string
  visibility: 'shared' | 'private'
  embedding: Array<number>
}) {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: opts.title })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  await db.insert(note).values({
    entityId: row.id,
    title: opts.title,
    bodyMd: opts.body,
    authorId: opts.authorId,
    visibility: opts.visibility,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  })
  await db.insert(link).values({
    fromEntityId: row.id,
    toEntityId: opts.on,
    relation: 'tagged_in',
    source: 'manual',
  })
  await db.insert(chunk).values({
    entityId: row.id,
    sourceKind: 'note',
    idx: 0,
    text: opts.body,
    embedding: opts.embedding,
    embeddingModel: MODEL,
  })
  return row.id
}

/** A deal's close_reason chunk, as the chunk.embed job leaves it. */
async function closeReason(
  dealId: string,
  text: string,
  embedding: Array<number>,
  embeddingModel = MODEL,
) {
  await db.insert(chunk).values({
    entityId: dealId,
    sourceKind: 'attribute',
    sourceKey: 'close_reason',
    idx: 0,
    text,
    embedding,
    embeddingModel,
  })
}

const assemble = (
  entityId: string,
  opts: { userId?: string; similar?: boolean; budgetChars?: number } = {},
) =>
  Effect.runPromise(
    assembleProgram(
      { entityId },
      {
        user: { id: opts.userId ?? FIXTURE_ACTOR.id },
        asOf: ASOF,
        budgetChars: opts.budgetChars ?? 8000,
        ...(opts.similar === undefined ? {} : { similar: opts.similar }),
      },
    ).pipe(Effect.provide(SimilarLaneLive)),
  )

const similarRefs = (r: AssembleResult) =>
  r.items.filter((i) => i.hop === 'similar').map((i) => i.ref)

describe('the similar lane', () => {
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    await setPin(true)
    const teammate = (
      await db
        .insert(user)
        .values({
          id: `sim-teammate-${randomUUID().slice(0, 8)}`,
          name: 'Other Partner',
          email: `${randomUUID()}@fund.example`,
        })
        .returning({ id: user.id })
    ).at(0)
    if (!teammate) throw new Error('user insert returned nothing')
    ids.teammate = teammate.id

    // ---- the anchor: the company, its deal, and what is filed on them ----
    ids.co = await newRecord('company', 'Coldplate Co', {
      description: 'Liquid cooling for edge racks',
    })
    ids.ownDeal = await newRecord('deal', 'Coldplate seed', {
      stage: 'passed',
    })
    await db.insert(link).values({
      fromEntityId: ids.ownDeal,
      toEntityId: ids.co,
      relation: 'references',
      attrSlug: 'company',
      source: 'manual',
    })
    // Its own deal's close_reason is its own history, never "similar".
    await closeReason(ids.ownDeal, 'Passed: too early.', toward(0))
    ids.ownNote = await filedNote({
      on: ids.co,
      title: 'First call',
      body: 'Cold plates for edge racks; thermal wedge.',
      authorId: FIXTURE_ACTOR.id,
      visibility: 'shared',
      embedding: toward(0),
    })

    // ---- other records ----
    ids.passed = await newRecord('deal', 'Frostbyte seed', { stage: 'passed' })
    await closeReason(
      ids.passed,
      'Passed: founders could not sell to hyperscalers.',
      toward(0, { axis: 1, by: 0.2 }), // ≈ 0.02
    )
    ids.sharedPassNote = await filedNote({
      on: ids.passed,
      title: 'Why we passed on Frostbyte',
      body: 'Immersion is a services business at this size.',
      authorId: FIXTURE_ACTOR.id,
      visibility: 'shared',
      embedding: toward(0, { axis: 2, by: 0.3 }), // ≈ 0.04
    })
    // A teammate's private pass note — the nearest chunk of all.
    ids.privatePassNote = await filedNote({
      on: ids.passed,
      title: 'Private doubts on Frostbyte',
      body: 'I did not trust the CEO.',
      authorId: ids.teammate,
      visibility: 'private',
      embedding: toward(0),
    })

    ids.far = await newRecord('deal', 'Far deal', { stage: 'lost' })
    await closeReason(
      ids.far,
      'Lost: a faster fund.',
      toward(0, { axis: 3, by: 1.2 }), // ≈ 0.36, past the bound
    )

    ids.stale = await newRecord('deal', 'Stale deal', { stage: 'passed' })
    await closeReason(ids.stale, 'Passed: stale.', toward(0), 'old-model')

    // An invested deal: its note is the closest chunk there is, and still
    // not a pass reason. Its close_reason, farther out, still ranks.
    ids.invested = await newRecord('deal', 'Invested deal', {
      stage: 'invested',
    })
    ids.investedNote = await filedNote({
      on: ids.invested,
      title: 'Why we invested',
      body: 'Cold plates, great team, we led.',
      authorId: FIXTURE_ACTOR.id,
      visibility: 'shared',
      embedding: toward(0),
    })
    await closeReason(
      ids.invested,
      'Invested: led the seed.',
      toward(0, { axis: 4, by: 0.5 }), // ≈ 0.11
    )

    // A note on a live deal is not a judgment yet.
    ids.live = await newRecord('deal', 'Live deal', { stage: 'screening' })
    ids.liveNote = await filedNote({
      on: ids.live,
      title: 'Screening notes',
      body: 'Cold plates again.',
      authorId: FIXTURE_ACTOR.id,
      visibility: 'shared',
      embedding: toward(0),
    })
  })

  it('leaves the default assembly alone: no mode, no similar item', async () => {
    const off = await assemble(ids.co)
    expect(similarRefs(off)).toEqual([])
    expect(await assemble(ids.co, { similar: false })).toEqual(off)
  })

  it("surfaces other deals' nearest close_reasons and terminal-stage notes, each citable", async () => {
    const on = await assemble(ids.co, { similar: true })
    const refs = similarRefs(on)

    expect(refs).toEqual([
      ref.attr(ids.passed, 'close_reason'),
      ref.note(ids.sharedPassNote),
      ref.attr(ids.invested, 'close_reason'),
    ])
    // not the anchor's own deal, nor anything past the bound, stale, or live
    expect(refs).not.toContain(ref.attr(ids.ownDeal, 'close_reason'))
    expect(refs).not.toContain(ref.attr(ids.far, 'close_reason'))
    expect(refs).not.toContain(ref.attr(ids.stale, 'close_reason'))
    expect(refs).not.toContain(ref.note(ids.liveNote))
    // the walk's own note stays the walk's, at hop 1
    expect(on.items.find((i) => i.ref === ref.note(ids.ownNote))?.hop).toBe(1)

    const reason = on.items.find(
      (i) => i.ref === ref.attr(ids.passed, 'close_reason'),
    )
    expect(reason?.kind).toBe('attribute')
    expect(reason?.text).toBe(
      'Similar judgment — close reason on Frostbyte seed (Passed): Passed: founders could not sell to hyperscalers.',
    )

    const resolved = await Effect.runPromise(resolveRefsProgram(refs))
    expect(resolved.map((r) => r.label)).toEqual([
      'Close reason on Frostbyte seed',
      'Why we passed on Frostbyte',
      'Close reason on Invested deal',
    ])

    // everything the graph found is still there, in the same order
    const off = await assemble(ids.co)
    expect(on.items.filter((i) => i.hop !== 'similar')).toEqual(off.items)
  })

  it("never ranks a teammate's private pass note for anyone but its author", async () => {
    const mine = similarRefs(await assemble(ids.co, { similar: true }))
    expect(mine).not.toContain(ref.note(ids.privatePassNote))

    const theirs = similarRefs(
      await assemble(ids.co, { userId: ids.teammate, similar: true }),
    )
    expect(theirs).toContain(ref.note(ids.privatePassNote))
    expect(theirs.filter((r) => r !== ref.note(ids.privatePassNote))).toEqual(
      mine,
    )
  })

  it("never ranks an invested deal's note, even the closest chunk", async () => {
    const on = await assemble(ids.co, { similar: true })
    const refs = similarRefs(on)
    expect(refs).not.toContain(ref.note(ids.investedNote))
    // its close_reason is not a note, and stays in
    expect(refs).toContain(ref.attr(ids.invested, 'close_reason'))
    expect(
      on.items.find((i) => i.ref === ref.attr(ids.invested, 'close_reason'))
        ?.text,
    ).toBe(
      'Similar judgment — close reason on Invested deal (Invested): Invested: led the seed.',
    )
  })

  it('returns nothing without a pin — no lexical fallback', async () => {
    await setPin(false)
    try {
      const off = await assemble(ids.co)
      const on = await assemble(ids.co, { similar: true })
      expect(similarRefs(on)).toEqual([])
      expect(on).toEqual(off)
    } finally {
      await setPin(true)
    }
  })

  it('returns nothing when the record has no embedded chunk to anchor on', async () => {
    const bare = await newRecord('company', 'Bare Co')
    expect(similarRefs(await assemble(bare, { similar: true }))).toEqual([])
  })

  it('never crowds out hop-0 attributes, and stays inside its slice', async () => {
    const budgetChars = 600
    const on = await assemble(ids.co, { similar: true, budgetChars })
    expect(on.items.find((i) => i.hop === 0 && i.kind === 'attribute')).toEqual(
      (await assemble(ids.co, { budgetChars })).items.find(
        (i) => i.hop === 0 && i.kind === 'attribute',
      ),
    )
    const used = on.items
      .filter((i) => i.hop === 'similar')
      .reduce((n, i) => n + i.text.length, 0)
    expect(used).toBeLessThanOrEqual(Math.floor(budgetChars * 0.15))
    expect(on.dropped.some((d) => d.reason === 'similar_budget')).toBe(true)
  })

  it(`takes the nearest ${String(SIMILAR_TOP_N)} and no more`, async () => {
    // Seven more passed deals, each a little farther out, all inside the bound.
    for (let n = 0; n < 7; n++) {
      const deal = await newRecord('deal', `Extra ${String(n)}`, {
        stage: 'passed',
      })
      await closeReason(
        deal,
        `Passed: reason ${String(n)}.`,
        toward(0, { axis: 10 + n, by: 0.35 + n * 0.05 }),
      )
    }
    const on = await assemble(ids.co, { similar: true, budgetChars: 100_000 })
    const lane = on.items.filter((i) => i.hop === 'similar')
    expect(lane).toHaveLength(SIMILAR_TOP_N)
    expect(lane.slice(0, 2).map((i) => i.ref)).toEqual([
      ref.attr(ids.passed, 'close_reason'),
      ref.note(ids.sharedPassNote),
    ])
    expect(SIMILAR_MAX_DISTANCE).toBe(0.35)
  })
})
