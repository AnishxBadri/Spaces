import { Effect, Exit } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  link,
  note,
  space,
  term,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { Spaces } from '@spaces/sdk'
import type { SpaceBrief } from '@spaces/sdk'
import { setValues } from '../attributes/values'
import { resolveEntity } from '../entities/resolve'
import { SpacesLive } from '../ports/spaces'
import { spaceBriefProgram } from './space-brief'

/**
 * The watch brief on the test database: a market map three levels deep with
 * memos, terms, members and a sensitive and an archived branch, read as an
 * integration through `SpacesLive`.
 */

let me = ''
let integrationId = ''

const aSpace = async (
  slug: string,
  parent?: { id: string; path: string },
  flags: { sensitive?: boolean; criteria?: string; archived?: boolean } = {},
) => {
  const ent = (
    await db
      .insert(entity)
      .values({
        kind: 'space',
        canonicalName: slug[0].toUpperCase() + slug.slice(1),
        sourceClass: 'manual',
        sensitive: flags.sensitive ?? false,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  const path = parent === undefined ? slug : `${parent.path}.${slug}`
  await db.insert(space).values({
    entityId: ent.id,
    parentId: parent?.id ?? null,
    slug,
    path,
    criteria: flags.criteria ?? null,
    archivedAt: flags.archived === true ? new Date() : null,
  })
  return { id: ent.id, path }
}

const aCompany = async (name: string, domain: string, sensitive = false) => {
  const { entityId } = await resolveEntity({
    kind: 'company',
    name,
    keys: { domain },
    source: { class: 'manual' },
  })
  if (sensitive)
    await db
      .update(entity)
      .set({ sensitive: true })
      .where(eq(entity.id, entityId))
  return entityId
}

const file = (entityId: string, spaceId: string) =>
  db.insert(entitySpace).values({ entityId, spaceId })

const aMemo = async (
  title: string,
  spaceId: string,
  how: 'filed' | 'tagged',
  visibility: 'shared' | 'private' = 'shared',
) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: title })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no note')
  await db.insert(note).values({
    entityId: ent.id,
    title,
    bodyMd: `${title}: the thesis.`,
    kind: 'memo',
    authorId: me,
    visibility,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  })
  if (how === 'filed') await file(ent.id, spaceId)
  else
    await db.insert(link).values({
      fromEntityId: ent.id,
      toEntityId: spaceId,
      relation: 'tagged_in',
      source: 'manual',
    })
  return ent.id
}

const aTerm = async (name: string, spaceId: string) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'term', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no term')
  await db.insert(term).values({
    entityId: ent.id,
    name,
    aliases: [`${name}s`],
    definitionMd: `What ${name} means here.`,
    spaceId,
  })
  return ent.id
}

const brief = (spaceId: string) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* Spaces).brief(spaceId)
    }).pipe(Effect.provide(SpacesLive({ id: integrationId }))),
  )

const ok = async (spaceId: string): Promise<SpaceBrief> => {
  const exit = await brief(spaceId)
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return exit.value
}

const refusal = async (spaceId: string) => {
  const exit = await brief(spaceId)
  if (Exit.isSuccess(exit)) throw new Error('expected a refusal')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

const ids: Record<string, string> = {}

beforeAll(async () => {
  const u = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!u) throw new Error('the core seed has a fixture user')
  me = u.id
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'watcher', version: '0.1.0', enabled: true })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  integrationId = row.id

  const spacetech = await aSpace('spacetech')
  const launch = await aSpace('launch', spacetech, {
    criteria: 'Companies building small-lift launch vehicles.',
  })
  const small = await aSpace('small', launch)
  const secret = await aSpace('secret', launch, { sensitive: true })
  const shelved = await aSpace('shelved', launch, { archived: true })
  const hushed = await aSpace('hushed', undefined, { sensitive: true })
  const under = await aSpace('under', hushed)
  Object.assign(ids, {
    spacetech: spacetech.id,
    launch: launch.id,
    small: small.id,
    secret: secret.id,
    shelved: shelved.id,
    under: under.id,
  })

  ids.varda = await aCompany('Varda', 'varda.example')
  await setValues({
    entityId: ids.varda,
    patch: {
      funding_stage: 'series_a',
      location: 'El Segundo',
      description: 'In-space manufacturing.',
    },
    actor: { type: 'user', id: me },
  })
  await file(ids.varda, launch.id)
  ids.rocketlab = await aCompany('Rocket Lab', 'rocketlab.example')
  await file(ids.rocketlab, small.id)
  ids.ghost = await aCompany('Ghost', 'ghost.example', true)
  await file(ids.ghost, launch.id)
  ids.hidden = await aCompany('Hidden', 'hidden.example')
  await file(ids.hidden, secret.id)
  ids.twice = await aCompany('Twice', 'twice.example')
  await file(ids.twice, launch.id)
  await file(ids.twice, hushed.id)

  ids.memo = await aMemo('Launch thesis', launch.id, 'filed')
  ids.tagged = await aMemo('Old thesis', launch.id, 'tagged')
  ids.parentMemo = await aMemo('Space economy', spacetech.id, 'filed')
  ids.private = await aMemo('My doubts', launch.id, 'filed', 'private')
  ids.term = await aTerm('Small-lift', launch.id)
  ids.parentTerm = await aTerm('LEO', spacetech.id)
})

describe('Spaces.brief', () => {
  it('hands the space over as data: path, criteria, memos, terms, members and the tree', async () => {
    const b = await ok(ids.launch)
    expect(b.space).toEqual({
      id: ids.launch,
      name: 'Launch',
      criteria: 'Companies building small-lift launch vehicles.',
    })
    expect(b.path).toEqual([
      { id: ids.spacetech, name: 'Spacetech' },
      { id: ids.launch, name: 'Launch' },
    ])
    // The subject's memos first, then up the path; a private one never.
    expect(b.memos.map((m) => [m.ref, m.spaceId, m.title])).toEqual([
      [`memo:${ids.memo}`, ids.launch, 'Launch thesis'],
      [`memo:${ids.tagged}`, ids.launch, 'Old thesis'],
      [`memo:${ids.parentMemo}`, ids.spacetech, 'Space economy'],
    ])
    expect(b.terms).toEqual([
      {
        ref: `term:${ids.parentTerm}`,
        spaceId: ids.spacetech,
        name: 'LEO',
        aliases: ['LEOs'],
        definition: 'What LEO means here.',
      },
      {
        ref: `term:${ids.term}`,
        spaceId: ids.launch,
        name: 'Small-lift',
        aliases: ['Small-lifts'],
        definition: 'What Small-lift means here.',
      },
    ])
    // Sensitive by its own flag, by its filing, or filed elsewhere under a
    // sensitive space: none of the three leaves.
    expect(b.members).toEqual([
      {
        entityId: ids.rocketlab,
        name: 'Rocket Lab',
        spaceId: ids.small,
        domains: ['rocketlab.example'],
        values: {},
      },
      {
        entityId: ids.varda,
        name: 'Varda',
        spaceId: ids.launch,
        domains: ['varda.example'],
        values: {
          description: 'In-space manufacturing.',
          funding_stage: 'series_a',
          location: 'El Segundo',
        },
      },
    ])
    expect(b.memberCount).toBe(2)
    // The sensitive and the archived subspace leave the tree.
    expect(b.tree).toEqual({
      id: ids.launch,
      name: 'Launch',
      companies: 3,
      children: [{ id: ids.small, name: 'Small', companies: 1, children: [] }],
    })
  })

  it('is data, not a rendered prompt — every member value is the stored JSON', async () => {
    const b = await ok(ids.launch)
    const text = JSON.stringify(b)
    expect(text).not.toMatch(/Filed in:|Memo: |Mandate:/)
    expect(b.members.at(1)?.values.funding_stage).toBe('series_a')
    expect(JSON.parse(text)).toEqual(b)
  })

  it('refuses a space sensitive anywhere in its path, naming where', async () => {
    const own = await refusal(ids.secret)
    expect(own).toMatchObject({ _tag: 'JobPermanent' })
    expect(own.reason).toMatch(/Secret is sensitive/)
    const inherited = await refusal(ids.under)
    expect(inherited.reason).toMatch(/Under is sensitive \(via Hushed\)/)
  })

  it('refuses an archived space and a missing one', async () => {
    expect((await refusal(ids.shelved)).reason).toMatch(/Shelved is archived/)
    expect(
      (await refusal('00000000-0000-4000-8000-000000000000')).reason,
    ).toMatch(/no space/)
  })

  it('reads as its reader: the author of a private memo sees it, the integration never', async () => {
    const asAuthor = await Effect.runPromise(
      spaceBriefProgram(ids.launch, { id: me }),
    )
    expect(asAuthor.memos.map((m) => m.title)).toContain('My doubts')
    expect((await ok(ids.launch)).memos.map((m) => m.title)).not.toContain(
      'My doubts',
    )
  })
})

describe('a space as the assembler’s subject (D71)', () => {
  const assemble = async (spaceId: string) => {
    const { assembleProgram } = await import('./assemble')
    const { SimilarLaneEmpty } = await import('../../context/similar-lane')
    return Effect.runPromise(
      assembleProgram(
        { entityId: spaceId },
        { user: { id: me }, asOf: '2026-10-10T00:00:00Z', budgetChars: 20_000 },
      ).pipe(Effect.provide(SimilarLaneEmpty)),
    )
  }
  const textOf = (
    r: Awaited<ReturnType<typeof assemble>>,
    ref: string,
  ): string => r.items.find((i) => i.ref === ref)?.text ?? ''

  it('returns the tree with counts, members by stage, memos and terms', async () => {
    const r = await assemble(ids.launch)
    expect(r.seed).toEqual({ id: ids.launch, kind: 'space', name: 'Launch' })
    expect(textOf(r, `attr:${ids.launch}:path`)).toBe(
      'Space: Spacetech › Launch',
    )
    expect(textOf(r, `attr:${ids.launch}:criteria`)).toBe(
      'Criteria: Companies building small-lift launch vehicles.',
    )
    // The archived branch leaves; the sensitive one stays, and marks the call.
    const tree = textOf(r, `attr:${ids.launch}:tree`)
    expect(tree.split('\n').slice(1)).toEqual([
      'Launch · 3',
      '  Secret · 1',
      '  Small · 1',
    ])
    expect(tree).not.toContain('Shelved')
    const byStage = textOf(r, `attr:${ids.launch}:by_stage`).split('\n')
    expect(byStage.at(0)).toMatch(/by stage \(5\)/)
    expect(byStage).toContain('Series A: Varda')
    expect(byStage.at(-1)).toBe('No stage: Ghost, Hidden, Rocket Lab, Twice')
    expect(textOf(r, `attr:${ids.varda}:member`)).toMatch(
      /^Varda — .*Funding stage: Series A/,
    )
    expect(textOf(r, `attr:${ids.rocketlab}:member`)).toMatch(
      /^Rocket Lab \(in Small\)/,
    )
    const refs = r.items.map((i) => i.ref)
    expect(refs).toEqual(
      expect.arrayContaining([
        `memo:${ids.memo}`,
        `memo:${ids.tagged}`,
        `memo:${ids.parentMemo}`,
        `memo:${ids.private}`,
        `term:${ids.term}`,
        `term:${ids.parentTerm}`,
      ]),
    )
    expect(r.items.find((i) => i.ref === `memo:${ids.memo}`)?.hop).toBe(1)
    expect(r.items.find((i) => i.ref === `memo:${ids.parentMemo}`)?.hop).toBe(2)
    expect(r.sensitive).toBe(true)
    expect(r.reveals).toEqual(
      expect.arrayContaining([ids.secret, ids.hidden, ids.ghost]),
    )
  })

  it('is sensitive only when something under it is', async () => {
    const small = await assemble(ids.small)
    expect(small.sensitive).toBe(false)
    expect(
      textOf(small, `attr:${ids.small}:tree`).split('\n').slice(1),
    ).toEqual(['Small · 1'])
    // Its own path is sensitive: so is the call.
    expect((await assemble(ids.under)).sensitive).toBe(true)
  })

  it('leaves the watch brief exactly as it was', async () => {
    const b = await ok(ids.launch)
    expect(b.members.map((m) => m.name)).toEqual(['Rocket Lab', 'Varda'])
  })
})
