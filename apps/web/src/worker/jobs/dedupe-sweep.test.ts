import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { JobWithMetadata } from 'pg-boss'
import { runJob } from '../run-job'
import type { JobHost, JobOutcome, JobRunLedger } from '../run-job'
import {
  DEDUPE_SWEEP_BOUNDS,
  dedupeSweep,
  dedupeSweepData,
  runDedupeSweepJob,
} from './dedupe-sweep'

/**
 * The nightly sweep, driven directly against this worker's test database —
 * truncated and reseeded before the file was imported (SPA-145), so there is
 * no cleanup here and nothing to add when a table appears.
 *
 * Every run is scoped with `{ objectId }`. That is not decoration: the job's
 * unscoped shape is what the 03:30 schedule sends, and a test running it
 * unscoped would pair whatever the seed and the other cases left lying
 * around. The scope is also the thing this slice's third criterion is about,
 * so exercising it is exercising the feature.
 */

const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x])

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [row] = await db.select({ id: user.id }).from(user).limit(1)
  expect(row).toBeTruthy()
  return row.id
}

/** The measured score, straight from the extension the sweep queries. */
async function similarity(a: string, b: string): Promise<number> {
  const { db } = await import('@spaces/db')
  const { sql } = await import('drizzle-orm')
  const rows = await db.execute<{ s: number }>(
    sql`select similarity(${a}, ${b}) as s`,
  )
  return Number(rows.rows[0].s)
}

async function newObject(singular: string, plural: string, createdBy: string) {
  const { Effect } = await import('effect')
  const { createObjectProgram } =
    await import('#/lib/attributes/object-registry')
  return Effect.runPromise(createObjectProgram({ singular, plural, createdBy }))
}

async function newRecord(objectId: string, name: string, userId: string) {
  const { Effect } = await import('effect')
  const { createRecordProgram } =
    await import('#/lib/attributes/object-registry')
  return Effect.runPromise(
    createRecordProgram({
      objectId,
      name,
      actor: { type: 'user', id: userId },
    }),
  )
}

/**
 * A record born straight through drizzle: entity row + one name alias, and
 * no at-create sweep. The cases below that are about what the *job* finds
 * want the at-create lane out of the picture entirely.
 */
async function born(
  objectId: string | null,
  name: string,
  kind: 'company' | 'person' | 'custom' | 'deal' = 'custom',
): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, entityAlias } = await import('@spaces/db/schema')
  const { normalizeName } = await import('@spaces/core/entities/normalize')
  const [row] = await db
    .insert(entity)
    .values({ kind, objectId, canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(entityAlias).values({
    entityId: row.id,
    kind: 'name',
    value: name,
    valueNorm: normalizeName(name),
  })
  return row.id
}

async function candidatesIn(objectId: string) {
  const { db } = await import('@spaces/db')
  const { duplicateCandidate, entity } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  return db
    .select({
      id: duplicateCandidate.id,
      entityA: duplicateCandidate.entityA,
      entityB: duplicateCandidate.entityB,
      score: duplicateCandidate.score,
      reason: duplicateCandidate.reason,
      status: duplicateCandidate.status,
    })
    .from(duplicateCandidate)
    .innerJoin(entity, eq(entity.id, duplicateCandidate.entityA))
    .where(eq(entity.objectId, objectId))
}

describe('dedupeSweepData', () => {
  it('accepts the nightly schedule’s empty payload and an object scope', () => {
    // pg-boss stores `data = null` for a schedule registered with no
    // payload, which is exactly how the 03:30 row is registered. A bare
    // z.object() would fail every nightly run before the handler ran.
    expect(dedupeSweepData.parse(null)).toEqual({})
    expect(dedupeSweepData.parse(undefined)).toEqual({})
    expect(dedupeSweepData.parse({})).toEqual({})

    const objectId = randomUUID()
    expect(dedupeSweepData.parse({ objectId })).toEqual({ objectId })
    expect(dedupeSweepData.safeParse({ objectId: 'not-a-uuid' }).success).toBe(
      false,
    )
  })
})

describe('dedupe sweep job', () => {
  it('finds two records renamed into similarity after birth', async () => {
    const { Effect } = await import('effect')
    const { renameRecordProgram } = await import('#/lib/entities/rename')
    const { normalizeName } = await import('@spaces/core/entities/normalize')

    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const funds = await newObject(`Fund ${tag}`, `Funds ${tag}`, me)

    // Born far apart: the at-create sweep saw these names and had nothing
    // to say, which is the premise of the whole job.
    const first = await newRecord(funds.id, 'Umbra Holdings', me)
    const second = await newRecord(funds.id, 'Kestrel Group', me)
    expect(
      await similarity(
        normalizeName('Umbra Holdings'),
        normalizeName('Kestrel Group'),
      ),
    ).toBeLessThan(0.5)
    expect(await candidatesIn(funds.id)).toEqual([])

    // …then renamed into each other. `renameRecordProgram` deliberately
    // runs no sweep of its own (see its closing comment), so nothing but
    // this job can see the drift.
    await Effect.runPromise(
      renameRecordProgram(me, { id: first.id, name: 'Vantage Partners' }),
    )
    await Effect.runPromise(
      renameRecordProgram(me, { id: second.id, name: 'Vantage Partners LLP' }),
    )
    expect(await candidatesIn(funds.id)).toEqual([])
    const drift = await similarity(
      normalizeName('Vantage Partners'),
      normalizeName('Vantage Partners LLP'),
    )
    expect(drift).toBeGreaterThanOrEqual(0.5)

    const result = await runDedupeSweepJob({ objectId: funds.id })
    expect(result.suggested).toBe(1)
    expect(result.scanned).toBe(2)
    expect(result.capped).toBe(false)

    const rows = await candidatesIn(funds.id)
    expect(rows.length).toBe(1)
    const [a, b] = pair(first.id, second.id)
    expect(rows[0].entityA).toBe(a)
    expect(rows[0].entityB).toBe(b)
    expect(rows[0].status).toBe('open')
    expect(Number(rows[0].score)).toBeCloseTo(drift, 5)
    expect(rows[0].reason.name_similarity).toBeTruthy()
  })

  it('never re-suggests a dismissed pair — run, dismiss, run again', async () => {
    const { db } = await import('@spaces/db')
    const { duplicateCandidate } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const vendors = await newObject(`Vendor ${tag}`, `Vendors ${tag}`, me)
    await born(vendors.id, 'Harlow Logistics')
    await born(vendors.id, 'Harlow Logistics Group')

    const first = await runDedupeSweepJob({ objectId: vendors.id })
    expect(first.suggested).toBe(1)
    const opened = await candidatesIn(vendors.id)
    expect(opened.length).toBe(1)

    await db
      .update(duplicateCandidate)
      .set({ status: 'dismissed', resolvedBy: me, resolvedAt: new Date() })
      .where(eq(duplicateCandidate.id, opened[0].id))

    // Second run, same pair, still over threshold. The unique pair index
    // plus onConflictDoNothing is the whole of the contract: dismissed is a
    // negative assertion the user made once.
    const again = await runDedupeSweepJob({ objectId: vendors.id })
    expect(again.suggested).toBe(0)
    const after = await candidatesIn(vendors.id)
    expect(after.length).toBe(1)
    expect(after[0].id).toBe(opened[0].id)
    expect(after[0].status).toBe('dismissed')
  })

  it('pairs within one object only, and never a record with itself', async () => {
    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const left = await newObject(`Alpha ${tag}`, `Alphas ${tag}`, me)
    const right = await newObject(`Beta ${tag}`, `Betas ${tag}`, me)

    // Byte-identical names in two objects. Same kind (`custom`) — a sweep
    // scoped by kind would have paired them.
    await born(left.id, 'Northwind Capital')
    await born(right.id, 'Northwind Capital')

    // One record holding two similar aliases of its own: the rename case,
    // and the self-pair the `a < b` join can never emit.
    const { db } = await import('@spaces/db')
    const { entityAlias } = await import('@spaces/db/schema')
    const { normalizeName } = await import('@spaces/core/entities/normalize')
    const solo = await born(left.id, 'Bramble Ventures')
    await db.insert(entityAlias).values({
      entityId: solo,
      kind: 'name',
      value: 'Bramble Ventures LLP',
      valueNorm: normalizeName('Bramble Ventures LLP'),
    })

    const result = await runDedupeSweepJob({ objectId: left.id })
    expect(result.suggested).toBe(0)
    expect(await candidatesIn(left.id)).toEqual([])
    expect(await candidatesIn(right.id)).toEqual([])
  })

  it('skips merged losers and kinds the merge executor refuses', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { MERGEABLE } = await import('#/lib/entities/merge')
    const { objectIdForKindAsync } = await import('#/lib/attributes/objects')

    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const trusts = await newObject(`Trust ${tag}`, `Trusts ${tag}`, me)

    const winner = await born(trusts.id, 'Ardent Trust')
    const loser = await born(trusts.id, 'Ardent Trust Holdings')
    await db
      .update(entity)
      .set({ mergedIntoId: winner })
      .where(eq(entity.id, loser))

    const merged = await runDedupeSweepJob({ objectId: trusts.id })
    expect(merged.scanned).toBe(1)
    expect(merged.suggested).toBe(0)
    expect(await candidatesIn(trusts.id)).toEqual([])

    // Deals hold name aliases the moment they are renamed (SPA-63), so the
    // accident that used to keep them out of the inbox is gone; MERGEABLE
    // is the invariant that replaces it, and the job reads the same set.
    expect(MERGEABLE.has('deal')).toBe(false)
    const deals = await objectIdForKindAsync('deal')
    await born(deals, 'Hyperion Series A', 'deal')
    await born(deals, 'Hyperion Series A Extension', 'deal')
    const dealRun = await runDedupeSweepJob({ objectId: deals })
    expect(dealRun.scanned).toBe(0)
    expect(dealRun.suggested).toBe(0)
    expect(await candidatesIn(deals)).toEqual([])
  })

  it('applies the top-k cap per entity in SQL, not in JS afterwards', async () => {
    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const funds = await newObject(`Sleeve ${tag}`, `Sleeves ${tag}`, me)

    // Six mutually similar names: 15 pairs clear the threshold, and the
    // lowest-uuid record is the A side of up to five of them.
    const suffixes = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']
    for (const s of suffixes) await born(funds.id, `Meridian Sleeve ${s}`)

    const result = await runDedupeSweepJob({ objectId: funds.id })
    expect(result.scanned).toBe(6)
    expect(result.suggested).toBeGreaterThan(0)

    const rows = await candidatesIn(funds.id)
    const byA = new Map<string, number>()
    for (const row of rows)
      byA.set(row.entityA, (byA.get(row.entityA) ?? 0) + 1)
    for (const [, n] of byA) expect(n).toBeLessThanOrEqual(3)
    expect(DEDUPE_SWEEP_BOUNDS.perEntity).toBe(3)
    // Something was actually cut: 15 pairs are over threshold, at most 3 per
    // A side survive, and one record is the A side of five of them.
    expect(rows.length).toBeLessThan(15)
    expect(Math.max(...byA.values())).toBe(3)
  })

  it('stops at the per-run insert cap and says so', async () => {
    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const units = await newObject(`Unit ${tag}`, `Units ${tag}`, me)

    // Thirty mutually similar names. After the top-3 cut roughly 84 pairs
    // are still eligible, so the `limit` is what decides the run — and the
    // rest wait for tomorrow rather than arriving in the inbox tonight.
    for (let i = 0; i < 30; i++) {
      await born(units.id, `Cascade Unit ${String(i).padStart(2, '0')}`)
    }

    const result = await runDedupeSweepJob({ objectId: units.id })
    expect(DEDUPE_SWEEP_BOUNDS.perRun).toBe(50)
    expect(result.suggested).toBe(50)
    expect(result.capped).toBe(true)
    expect((await candidatesIn(units.id)).length).toBe(50)
  })
})

const epoch = new Date(0)

function fakeJob(data: object): JobWithMetadata<object> {
  return {
    id: randomUUID(),
    name: dedupeSweep.name,
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: 0,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: epoch,
    startedOn: epoch,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 604800,
    createdOn: epoch,
    completedOn: null,
    keepUntil: epoch,
    policy: 'standard',
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: '',
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  }
}

/**
 * The handler half: the queue that used to be `stub('entity.dedupe-sweep')`
 * settles through `runJob` now, on the name the 03:30 schedule fires into.
 * The schedule's own `null` payload is covered a layer down, against the
 * schema — `JobWithMetadata<object>` cannot hold a null `data` without a
 * type assertion, and a cast to prove a parse is a worse test than the
 * parse itself.
 */
describe('dedupeSweep JobDef', () => {
  it('registers on the dedupe queue and completes a run', async () => {
    const { QUEUES } = await import('@spaces/core/queue/names')
    const { Layer } = await import('effect')
    expect(dedupeSweep.name).toBe(QUEUES.dedupeSweep)

    const calls: Array<{ call: string; output: JobOutcome }> = []
    const host: JobHost = {
      complete: async (_q, _id, output) => {
        calls.push({ call: 'complete', output })
      },
      fail: async (_q, _id, output) => {
        calls.push({ call: 'fail', output })
      },
      failTerminal: async (_q, _id, output) => {
        calls.push({ call: 'failTerminal', output })
      },
      send: async () => undefined,
    }
    const ledger: JobRunLedger = {
      begin: async () => null,
      end: async () => undefined,
    }

    const me = await actorId()
    const tag = randomUUID().slice(0, 8)
    const clubs = await newObject(`Club ${tag}`, `Clubs ${tag}`, me)
    await born(clubs.id, 'Lantern Syndicate')
    await born(clubs.id, 'Lantern Syndicate II')

    await runJob(dedupeSweep, { host, layer: Layer.empty, ledger })([
      fakeJob({ objectId: clubs.id }),
    ])

    expect(calls.length).toBe(1)
    expect(calls[0].call).toBe('complete')
    expect(calls[0].output.kind).toBe('completed')
    expect((await candidatesIn(clubs.id)).length).toBe(1)
  })
})
