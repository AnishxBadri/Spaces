import { Effect, Schema } from 'effect'
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, interactionStat, signal } from '@spaces/db/schema'
import { holding, investment, round } from '@spaces/db/schema/portfolio'
import { jsonString } from '@spaces/core/json'
import { ownership } from '@spaces/core/portfolio/ownership'
import { companyPeopleProgram } from '#/lib/people/companies'
import { stageFunnelProgram } from '#/lib/deals/funnel'
import { num, partitionReversals, reversedAtOf } from '#/lib/portfolio/detail'
import { localDay } from './readout-format'

/**
 * The record head's readout strip: numbers and dates, never a word, never a
 * section's count.
 * - Interaction dates come from `interaction_stat` (D67), the rows the People
 *   and Companies lists sort on; one aggregate over the record's ids.
 * - Days are the server's local calendar days, with `today` beside them, so
 *   the server and the browser print the same string.
 *
 * Outside `lib/server/` so tests can call it without a request.
 */

/** A local calendar day, `YYYY-MM-DD`; null when there is none. */
export type ReadoutDay = string | null

export type PersonReadouts = {
  today: string
  lastContact: ReadoutDay
  lastEmail: ReadoutDay
  nextMeeting: ReadoutDay
  firstContact: ReadoutDay
}

export type CompanyReadouts = {
  today: string
  lastContact: ReadoutDay
  nextMeeting: ReadoutDay
  moving30: number
  /** Fully diluted (`actual`) or locked by a post-money SAFE (`implied`). */
  ownership: { kind: 'actual' | 'implied'; pct: number } | null
}

export type DealReadouts = {
  today: string
  lastContact: ReadoutDay
  daysInStage: number
  medianDaysInStage: number | null
  pastTwiceMedian: boolean
  /** The company's latest round: its size and post-money; null with none. */
  round: DealRound | null
}

export type DealRound = {
  raised: number | null
  postMoney: number | null
  currency: string
}

export type RecordReadouts = {
  today: string
  lastContact: ReadoutDay
  nextMeeting: ReadoutDay
  moving30: number
}

export class RecordReadoutsFailed extends Schema.TaggedError<RecordReadoutsFailed>()(
  'RecordReadoutsFailed',
  { cause: Schema.Defect() },
) {}

const MOVING_DAYS = 30
const DAY_MS = 86_400_000

const query = <TResult>(run: () => Promise<TResult>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RecordReadoutsFailed({ cause }),
  })

const dayOf = (raw: string | null): ReadoutDay =>
  raw === null ? null : localDay(new Date(raw))

/**
 * Last contact, last email, next meeting and first contact over any of
 * `entityIds`, from their `interaction_stat` rows.
 */
const interactionDays = Effect.fn('interactionDays')(function* (
  entityIds: Array<string>,
) {
  const any = sql`${interactionStat.kind} = 'any'`
  const row = yield* query(async () =>
    (
      await db
        .select({
          last: sql<
            string | null
          >`max(${interactionStat.lastAt}) filter (where ${any})`,
          lastEmail: sql<
            string | null
          >`max(${interactionStat.lastAt}) filter (where ${interactionStat.kind} = 'email')`,
          next: sql<
            string | null
          >`min(${interactionStat.nextAt}) filter (where ${any})`,
          first: sql<
            string | null
          >`min(${interactionStat.firstAt}) filter (where ${any})`,
        })
        .from(interactionStat)
        .where(inArray(interactionStat.entityId, entityIds))
    ).at(0),
  )
  return {
    last: dayOf(row?.last ?? null),
    lastEmail: dayOf(row?.lastEmail ?? null),
    next: dayOf(row?.next ?? null),
    first: dayOf(row?.first ?? null),
  }
})

/** Signals on the record in the last 30 days. */
const movingCount = Effect.fn('movingCount')(function* (
  entityId: string,
  now: Date,
) {
  const since = new Date(now.getTime() - MOVING_DAYS * DAY_MS)
  const row = yield* query(async () =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(signal)
        .where(
          and(eq(signal.entityId, entityId), gte(signal.observedAt, since)),
        )
    ).at(0),
  )
  return row?.n ?? 0
})

/** Our ownership of a company, from its holding's ledger; null if not held. */
const companyOwnership = Effect.fn('companyOwnership')(function* (
  companyId: string,
) {
  const held = yield* query(async () =>
    (
      await db
        .select({ id: holding.id })
        .from(holding)
        .where(eq(holding.companyId, companyId))
    ).at(0),
  )
  if (!held) return null
  const [invRows, roundRows] = yield* query(() =>
    Promise.all([
      db
        .select()
        .from(investment)
        .where(eq(investment.holdingId, held.id))
        .orderBy(asc(investment.date)),
      db
        .select()
        .from(round)
        .where(eq(round.companyId, companyId))
        .orderBy(asc(round.date)),
    ]),
  )
  const inv = partitionReversals(invRows)
  const own = ownership(
    inv.originals.map((r) => ({
      date: r.date,
      amount: Number(r.amount),
      instrument: r.instrument,
      shares: num(r.shares),
      cap: num(r.cap),
      reversedAt: reversedAtOf(inv.reversalOf, r.id),
    })),
    roundRows.map((r) => ({
      date: r.date,
      kind: r.kind,
      sharesOutstanding: num(r.sharesOutstanding),
    })),
  )
  if (own.kind === 'actual')
    return { kind: 'actual' as const, pct: own.currentPct }
  if (own.kind === 'implied') return { kind: 'implied' as const, pct: own.pct }
  return null
})

export const personReadoutsProgram = Effect.fn('personReadoutsProgram')(
  function* (personId: string, now: Date) {
    const days = yield* interactionDays([personId])
    const out: PersonReadouts = {
      today: localDay(now),
      lastContact: days.last,
      lastEmail: days.lastEmail,
      nextMeeting: days.next,
      firstContact: days.first,
    }
    return out
  },
)

/** Last contact and next meeting run over the company and its Team (people whose `companies` holds it). */
export const companyReadoutsProgram = Effect.fn('companyReadoutsProgram')(
  function* (companyId: string, now: Date) {
    const team = yield* companyPeopleProgram(companyId)
    const days = yield* interactionDays([companyId, ...team.map((p) => p.id)])
    const out: CompanyReadouts = {
      today: localDay(now),
      lastContact: days.last,
      nextMeeting: days.next,
      moving30: yield* movingCount(companyId, now),
      ownership: yield* companyOwnership(companyId),
    }
    return out
  },
)

/**
 * A deal's last contact is derived through its company and its people,
 * plus anything pinned to the deal itself. (D49)
 * Days in stage is crimson past twice the stage's median — the median
 * Today's "Idle in stage" reads.
 */
export const dealReadoutsProgram = Effect.fn('dealReadoutsProgram')(function* (
  dealId: string,
  now: Date,
) {
  const head = yield* query(async () =>
    (
      await db
        .select({ values: entity.values, createdAt: entity.createdAt })
        .from(entity)
        .where(eq(entity.id, dealId))
    ).at(0),
  )
  if (!head) return yield* new RecordReadoutsFailed({ cause: 'no deal' })
  const companyId = jsonString(head.values.company)
  const peopleIds = Array.isArray(head.values.people)
    ? head.values.people.filter((v): v is string => typeof v === 'string')
    : []
  const days = yield* interactionDays([
    dealId,
    ...(companyId ? [companyId] : []),
    ...peopleIds,
  ])

  const funnel = yield* stageFunnelProgram(now.getTime())
  const stage = jsonString(head.values.stage)
  const logged = funnel.daysInStage.find((d) => d.id === dealId)?.days
  // A deal with no stage event entered its stage when it was born.
  const inStage = logged ?? (now.getTime() - head.createdAt.getTime()) / DAY_MS
  const median =
    stage === null ? null : (funnel.medianDaysInStage[stage] ?? null)
  const out: DealReadouts = {
    today: localDay(now),
    lastContact: days.last,
    daysInStage: Math.max(0, Math.floor(inStage)),
    medianDaysInStage: median,
    pastTwiceMedian: median !== null && median > 0 && inStage > 2 * median,
    round: companyId ? yield* latestRound(companyId) : null,
  }
  return out
})

/**
 * A company's latest round: a dated event, written by the ledger or by
 * enrichment (D76). One with neither a size nor a post-money reads as none.
 */
const latestRound = Effect.fn('latestRound')(function* (companyId: string) {
  const row = yield* query(async () =>
    (
      await db
        .select({
          raised: round.raised,
          postMoney: round.postMoney,
          currency: round.currency,
        })
        .from(round)
        .where(eq(round.companyId, companyId))
        .orderBy(desc(round.date), desc(round.createdAt))
        .limit(1)
    ).at(0),
  )
  if (!row || (row.raised === null && row.postMoney === null)) return null
  const out: DealRound = {
    raised: num(row.raised),
    postMoney: num(row.postMoney),
    currency: row.currency ?? 'USD',
  }
  return out
})

/** A custom record's own interactions and signals. */
export const recordReadoutsProgram = Effect.fn('recordReadoutsProgram')(
  function* (recordId: string, now: Date) {
    const days = yield* interactionDays([recordId])
    const out: RecordReadouts = {
      today: localDay(now),
      lastContact: days.last,
      nextMeeting: days.next,
      moving30: yield* movingCount(recordId, now),
    }
    return out
  },
)
