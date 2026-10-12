import { Effect, Schema } from 'effect'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  askThread,
  askTurn,
  spaceWatchDismissal,
  suggestion,
} from '@spaces/db/schema'
import { normalizeDomain } from '@spaces/core/entities/normalize'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  DiscoverSpaceRefused,
  discoverProgram,
  standingProgram,
} from '@spaces/core/writes/ports/discover'
import type { SuggestionFailure } from '@spaces/core/writes/suggestions/propose'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import {
  acceptProgram,
  rejectProgram,
  suggestionMessage,
} from '#/lib/ai/propose'
import { emitDomainEvent } from '#/lib/events/emit'
import { askQuery } from './query'
import type { AskQueryFailed } from './query'
import type { AskCall, AskFindRow, AskFindTable, AskVia } from './types'

/**
 * Find in Ask: the companies a web search turned up, shown as a table and
 * read against what is held. (D77)
 * - A row cites pages a mounted plugin's call returned this turn; a row the
 *   model could not source is left out.
 * - Each row passes the Discover checks for the turn's space: filed there,
 *   held elsewhere, unknown, or dismissed — hidden and counted.
 * - A result is a web result until it is added. Add resolves the company;
 *   Add and file here and File here go through the discovery card, so a
 *   watch's open card for the domain is the one accepted. Finding never
 *   creates a deal.
 */

export const SHOW_COMPANIES = 'show_companies'

/** The most rows one table holds. */
export const FIND_MAX_ROWS = 50

export const showCompaniesShape = {
  companies: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(300),
        domain: z.string().trim().min(1).max(253),
        line: z
          .string()
          .trim()
          .max(300)
          .describe('What the company does, in one line'),
        place: z
          .string()
          .trim()
          .max(120)
          .nullable()
          .describe('Where it is based; null when the pages do not say'),
        sources: z
          .array(z.string().url().max(2000))
          .min(1)
          .max(3)
          .describe(
            'One to three page URLs, exactly as a web tool returned them',
          ),
      }),
    )
    .min(1)
    .max(FIND_MAX_ROWS),
}

export const SHOW_COMPANIES_DESCRIPTION =
  'Show the reader the companies a web search found, as a table — never list them as prose. For each company: its name, its domain, what it does in one line, where it is based, and one to three source URLs exactly as a web tool returned them. Each row is checked against the workspace: already filed here, held elsewhere, or new, and the reader adds or files from the table. Call it once per question, after searching.'

type ShownCompany = z.infer<
  z.ZodObject<typeof showCompaniesShape>
>['companies'][number]

/** A URL as compared against what a call returned: no fragment, no trailing slash. */
export const urlKey = (url: string): string =>
  url.replace(/#.*$/, '').replace(/\/$/, '')

export class FindRefused extends Schema.TaggedError<FindRefused>()(
  'FindRefused',
  { message: Schema.String },
) {}

export class FindFailed extends Schema.TaggedError<FindFailed>()('FindFailed', {
  cause: Schema.Defect(),
}) {}

/** The sentence a failure is shown as. */
export function findMessage(failure: unknown): string {
  if (failure instanceof FindRefused) return failure.message
  if (failure instanceof DiscoverSpaceRefused)
    return 'That space no longer takes companies'
  return suggestionMessage(failure)
}

/** The table a `show_companies` call leaves, and what the model is told. */
export const findTableProgram = Effect.fn('ask.findTable')(function* (
  shown: ReadonlyArray<ShownCompany>,
  context: {
    /** Pages the turn's plugin calls returned, with the integration each came through. */
    seen: ReadonlyMap<string, AskVia>
    space: { id: string; name: string } | null
  },
) {
  const rows: Array<AskFindRow> = []
  const domains = new Set<string>()
  let hidden = 0
  let unsourced = 0
  for (const c of shown) {
    const domain = normalizeDomain(c.domain)
    if (domain === null || domains.has(domain)) continue
    const sources = [...new Set(c.sources)].filter((u) =>
      context.seen.has(urlKey(u)),
    )
    const via = sources
      .map((u) => context.seen.get(urlKey(u)))
      .find((v) => v !== undefined)
    if (via === undefined) {
      unsourced++
      continue
    }
    domains.add(domain)
    const read = yield* Effect.result(
      standingProgram({
        name: c.name,
        domain,
        spaceId: context.space?.id ?? null,
      }),
    )
    if (read._tag === 'Failure') continue
    const standing = read.success
    if (standing.standing === 'dismissed') {
      hidden++
      continue
    }
    rows.push({
      name: c.name,
      domain,
      line: c.line,
      place: c.place,
      sources: sources.map((url) => ({ url })),
      via,
      standing: standing.standing,
      entityId: standing.standing === 'unknown' ? null : standing.entityId,
    })
  }
  const table: AskFindTable = { space: context.space, rows, hidden }
  return {
    table,
    value: {
      shown: rows.length,
      alreadyFiledHere: rows.filter((r) => r.standing === 'filed').length,
      heldElsewhere: rows.filter((r) => r.standing === 'held').length,
      new: rows.filter((r) => r.standing === 'unknown').length,
      hiddenAsDismissed: hidden,
      leftOutWithoutASource: unsourced,
      note: 'The reader sees these as a table to add or file from. Do not list them again: say in a sentence or two what was found.',
    },
  }
})

/**
 * A stored table read again: each row's standing as it is now, a row
 * dismissed since hidden and counted. A row that cannot be read stays as
 * it was.
 */
export const liveFindProgram = Effect.fn('ask.liveFind')(function* (
  table: AskFindTable,
) {
  const rows: Array<AskFindRow> = []
  let hidden = table.hidden
  for (const row of table.rows) {
    const read = yield* Effect.result(
      standingProgram({
        name: row.name,
        domain: row.domain,
        spaceId: table.space?.id ?? null,
      }),
    )
    if (read._tag === 'Failure') {
      rows.push(row)
      continue
    }
    const standing = read.success
    if (standing.standing === 'dismissed') {
      hidden++
      continue
    }
    rows.push({
      ...row,
      standing: standing.standing,
      entityId: standing.standing === 'unknown' ? null : standing.entityId,
    })
  }
  return { ...table, rows, hidden }
})

/** Every call's find table read again; other calls as stored. */
export const liveCallsProgram = Effect.fn('ask.liveCalls')(function* (
  calls: ReadonlyArray<AskCall>,
) {
  const out: Array<AskCall> = []
  for (const call of calls)
    out.push(
      call.find === undefined
        ? call
        : { ...call, find: yield* liveFindProgram(call.find) },
    )
  return out
})

/** The row of `domain` in a find table of the reader's own answer. */
const ownRowProgram = Effect.fn('ask.findRow')(function* (
  userId: string,
  turnId: string,
  domain: string,
) {
  const turn = (yield* askQuery(() =>
    db
      .select({ calls: askTurn.calls })
      .from(askTurn)
      .innerJoin(askThread, eq(askThread.id, askTurn.threadId))
      .where(and(eq(askTurn.id, turnId), eq(askThread.userId, userId))),
  )).at(0)
  for (const call of turn?.calls ?? []) {
    const row = call.find?.rows.find((r) => r.domain === domain)
    if (call.find !== undefined && row !== undefined)
      return { row, space: call.find.space }
  }
  return yield* new FindRefused({
    message: 'That result is no longer in this thread',
  })
})

/** What an Add or a filing came to: the record, and whether it is filed here. */
export type FindActed = {
  entityId: string
  /** A record was born: its enrichment follows. */
  created: boolean
  filed: boolean
}

/**
 * Add: the company resolved as the reader, `entity.created` fired so D76
 * enrichment follows. Nothing is filed.
 */
export const addFindRowProgram = Effect.fn('ask.addFindRow')(function* (
  userId: string,
  turnId: string,
  domain: string,
): Effect.fn.Return<FindActed, FindRefused | FindFailed | AskQueryFailed> {
  const { row } = yield* ownRowProgram(userId, turnId, domain)
  const resolved = yield* Effect.tryPromise({
    try: () =>
      resolveEntity({
        kind: 'company',
        name: row.name,
        keys: { domain: row.domain },
        source: { class: 'manual' },
        createdBy: userId,
      }),
    catch: (cause) => new FindFailed({ cause }),
  })
  yield* Effect.promise(async () => {
    for (const s of resolved.reembed) await enqueueSourceEmbed(s)
    await emitDomainEvent(resolved.emit)
  })
  return {
    entityId: resolved.entityId,
    created: resolved.action === 'created',
    filed: false,
  }
})

/**
 * Add and file here, or File here: the row handed to Discover as the reader
 * — the space's open card for the domain, a watch's included, takes it — and
 * that card accepted, which resolves, files and fires `entity.created`.
 */
export const fileFindRowProgram = Effect.fn('ask.fileFindRow')(function* (
  userId: string,
  turnId: string,
  domain: string,
): Effect.fn.Return<
  FindActed,
  FindRefused | AskQueryFailed | DiscoverSpaceRefused | SuggestionFailure
> {
  const { row, space } = yield* ownRowProgram(userId, turnId, domain)
  if (space === null)
    return yield* new FindRefused({
      message: 'No space is in scope to file into',
    })
  const found = yield* discoverProgram({
    claim: {
      spaceId: space.id,
      name: row.name,
      domain: row.domain,
      evidence: row.sources.map((s) =>
        s.title === undefined ? { url: s.url } : { url: s.url, title: s.title },
      ),
    },
    proposedBy: { type: 'user', id: userId },
    watchId: null,
  })
  if (found.outcome === 'dismissed')
    return yield* new FindRefused({
      message: `${row.domain} is dismissed from ${space.name}`,
    })
  if (found.outcome === 'member')
    return { entityId: found.entityId, created: false, filed: true }
  const accepted = yield* acceptProgram(found.suggestion.id, {
    type: 'user',
    id: userId,
  })
  if (accepted.kind === 'add_record') {
    yield* Effect.promise(async () => {
      for (const s of accepted.resolved.reembed) await enqueueSourceEmbed(s)
    })
    return {
      entityId: accepted.resolved.entityId,
      created: accepted.resolved.action === 'created',
      filed: true,
    }
  }
  if (accepted.kind === 'file_record')
    return { entityId: accepted.entityId, created: false, filed: true }
  return yield* new FindRefused({ message: 'That card is not a filing' })
})

/**
 * Dismiss: permanent for (space, domain). The space's open discovery cards
 * for the domain are rejected — which writes the dismissal — and the row is
 * written whether or not one was open.
 */
export const dismissFindRowProgram = Effect.fn('ask.dismissFindRow')(function* (
  userId: string,
  turnId: string,
  domain: string,
) {
  const { row, space } = yield* ownRowProgram(userId, turnId, domain)
  if (space === null)
    return yield* new FindRefused({
      message: 'A dismissal is for a space, and none is in scope',
    })
  const open = yield* askQuery(() =>
    db
      .select({ id: suggestion.id })
      .from(suggestion)
      .where(
        and(
          eq(suggestion.status, 'open'),
          inArray(suggestion.kind, ['add_record', 'file_record']),
          sql`${suggestion.payload} ->> 'spaceId' = ${space.id}`,
          sql`${suggestion.payload} ->> 'domain' = ${row.domain}`,
        ),
      ),
  )
  for (const card of open)
    yield* rejectProgram(card.id, { type: 'user', id: userId })
  yield* askQuery(() =>
    db
      .insert(spaceWatchDismissal)
      .values({ spaceId: space.id, domain: row.domain, dismissedBy: userId })
      .onConflictDoNothing(),
  )
  return { dismissed: true }
})
