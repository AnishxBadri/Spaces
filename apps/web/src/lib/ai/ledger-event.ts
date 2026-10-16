import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import {
  document,
  documentRevision,
  entity,
  link,
  workspace,
} from '@spaces/db/schema'
import { holding } from '@spaces/db/schema/portfolio'
import type {
  LedgerBefore,
  LedgerEventPayload,
  MarkProposal,
  RoundProposal,
} from '@spaces/core/ai/ledger-event'
import { JSON_SCHEMA_DRAFT } from '@spaces/core/ai/schema'
import type { JsonSchema } from '@spaces/core/ai/schema'
import { ref } from '@spaces/core/context/ref'
import { jsonValue } from '@spaces/core/json'
import { heldLedgerEvent } from '@spaces/core/writes/suggestions/propose'
import { fmtPct } from '@spaces/core/portfolio/format'
import { loadHoldingDetail } from '#/lib/portfolio/detail'
import { completeMessage } from './complete'
import type { CompleteFailure } from './complete'
import { cachedExtractProgram } from './extraction-cache'
import { proposeProgram, suggestionMessage } from './propose'
import type { Suggestion, SuggestionFailure } from './propose'
import { providerFailure } from './providers/test-call'
import { callStep, suggestionOutputRef, withRun } from './run'
import type { RunScope } from './run'
import { sensitivityFor } from './sensitivity-for'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'

/**
 * Live-file ledger events (spec-ai-substrate §11, the cap_table row): a new
 * revision of a bound cap table, filed on a company we hold, is read
 * against the holding and becomes at most one `suggestion(kind:
 * 'ledger_event')` on the company — a round the ledger does not have yet,
 * else a mark at the round's price. Never an event: accepting it is what
 * appends one (`acceptProgram`), and nothing is ever edited (D12).
 *
 * - Only a revision: a cap table with no `document_revision` row is a first
 *   filing, and this lane leaves it alone.
 * - One proposal per (document, revision), in any status: a rejection is
 *   final, and a replayed revision asks the model nothing.
 * - Sensitive when the company or the document is; `complete()` refuses a
 *   sensitive read to the cloud.
 */

/** The head of the cap table the model reads. */
export const LEDGER_EVENT_TEXT_CHARS = 12_000
export const LEDGER_EVENT_BUDGET_CHARS = 16_000
/** The extraction cache's purpose. Bump when the task changes meaning. */
export const LEDGER_EVENT_PURPOSE = 'ledger-event/v1'

export class LedgerEventQueryFailed extends Schema.TaggedError<LedgerEventQueryFailed>()(
  'LedgerEventQueryFailed',
  { cause: Schema.Defect() },
) {}

export type LedgerEventFailure =
  | LedgerEventQueryFailed
  | CompleteFailure
  | SuggestionFailure
  | SensitivityReadFailed
  | SensitivityEntityNotFound

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new LedgerEventQueryFailed({ cause }),
  })

/** The sentence a failed run leaves on its job. */
export function ledgerEventMessage(failure: LedgerEventFailure): string {
  switch (failure._tag) {
    case 'LedgerEventQueryFailed':
      return 'Could not read the cap table or its holding'
    case 'SensitivityReadFailed':
      return 'Could not read the cap table’s sensitivity'
    case 'SensitivityEntityNotFound':
      return 'The cap table or its company is gone'
    case 'ProviderCallFailed':
      return `${completeMessage(failure)}: ${providerFailure(failure.cause).message}`
    case 'SuggestionNotFound':
    case 'SuggestionNotOpen':
    case 'UnsupportedSuggestionKind':
    case 'SuggestionInvalid':
    case 'EntityNotFound':
    case 'SuggestionWriteFailed':
      return suggestionMessage(failure)
    default:
      return completeMessage(failure)
  }
}

// ---------- the target ----------

/** A revised cap table and the holding it is read against. */
export type LedgerTarget = {
  documentId: string
  documentName: string
  /** The provider's revision id, else the bytes' sha. */
  revisionId: string
  companyId: string
  companyName: string
  holdingId: string
}

export type LedgerTargetRead =
  { ok: true; target: LedgerTarget } | { ok: false; reason: string }

const skip = (reason: string): LedgerTargetRead => ({ ok: false, reason })

/**
 * Whether this document is a revised cap table on a held company: the
 * enqueue gate (`onDocumentExtracted`) and the job's first read.
 */
export async function ledgerTargetOf(
  documentId: string,
): Promise<LedgerTargetRead> {
  const doc = (
    await db
      .select({
        kind: document.kind,
        filename: document.filename,
        name: entity.canonicalName,
        revision: sql<
          string | null
        >`coalesce(${document.externalRevisionId}, ${document.blobSha})`,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(eq(document.entityId, documentId))
  ).at(0)
  if (!doc) return skip('That document is gone')
  if (doc.kind !== 'cap_table') return skip('Only a cap table is read')
  if (doc.revision === null) return skip('The cap table holds no bytes')
  const revised = await db
    .select({ id: documentRevision.id })
    .from(documentRevision)
    .where(eq(documentRevision.documentId, documentId))
    .limit(1)
  if (revised.length === 0)
    return skip('A first filing, not a revision: nothing moved')
  const held = await db
    .select({
      companyId: entity.id,
      companyName: entity.canonicalName,
      holdingId: holding.id,
    })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .innerJoin(holding, eq(holding.companyId, entity.id))
    .where(
      and(
        eq(link.fromEntityId, documentId),
        eq(link.relation, 'tagged_in'),
        eq(entity.kind, 'company'),
        isNull(entity.mergedIntoId),
      ),
    )
    .orderBy(asc(entity.canonicalName))
  const only = held.at(0)
  if (only === undefined)
    return skip('Not filed on a company the portfolio holds')
  if (held.length > 1)
    return skip('Filed on more than one held company: whose ledger is unclear')
  return {
    ok: true,
    target: {
      documentId,
      documentName: doc.filename ?? doc.name,
      revisionId: doc.revision,
      ...only,
    },
  }
}

// ---------- the holding now ----------

/** What the proposal is diffed against. */
export type HoldingNow = {
  holdingId: string
  ownershipPct: number | null
  /** Live priced shares on the ledger. */
  ourShares: number
  latestMark: { date: string; fairValue: number; currency: string } | null
  latestRound: { date: string; kind: string } | null
  roundDates: ReadonlyArray<string>
  /** The currency a mark falls back to: the last mark's, else a cheque's. */
  currency: string | null
}

async function holdingNow(holdingId: string): Promise<HoldingNow> {
  const d = await loadHoldingDetail(holdingId)
  const live = <
    T extends { reversesId: string | null; reversedAt: string | null },
  >(
    rows: ReadonlyArray<T>,
  ) => rows.filter((r) => r.reversesId === null && r.reversedAt === null)
  const investments = live(d.investments)
  const marks = live(d.marks)
  const mark = marks.at(-1)
  const round = d.rounds.at(-1)
  return {
    holdingId,
    ownershipPct:
      d.ownership.kind === 'actual'
        ? d.ownership.currentPct
        : d.ownership.kind === 'implied'
          ? d.ownership.pct
          : null,
    ourShares: investments
      .filter((i) => i.instrument === 'priced')
      .reduce((sum, i) => sum + (i.shares ?? 0), 0),
    latestMark:
      mark === undefined
        ? null
        : {
            date: mark.date,
            fairValue: mark.fairValue,
            currency: mark.currency,
          },
    latestRound:
      round === undefined ? null : { date: round.date, kind: round.kind },
    roundDates: d.rounds.map((r) => r.date),
    currency: mark?.currency ?? investments.at(0)?.currency ?? null,
  }
}

// ---------- the read ----------

const num = z.number().finite()

/** The model's answer, read leniently: the choice below checks it. */
export const capTableReadSchema = z.object({
  round: z
    .object({
      date: z.string(),
      kind: z.string(),
      raised: num.optional(),
      currency: z.string().optional(),
      preMoney: num.optional(),
      postMoney: num.optional(),
      pricePerShare: num.optional(),
      sharesOutstanding: num.optional(),
    })
    .optional(),
  ownership: z
    .object({
      ourShares: num.optional(),
      fullyDilutedShares: num.optional(),
      pct: num.optional(),
    })
    .optional(),
  reason: z.string().optional(),
})

export type CapTableRead = z.infer<typeof capTableReadSchema>

function outputSchema(): JsonSchema {
  const number = (description: string): JsonSchema => ({
    type: 'number',
    description,
  })
  return {
    $schema: JSON_SCHEMA_DRAFT,
    title: 'cap table',
    type: 'object',
    properties: {
      round: {
        type: 'object',
        description:
          'The most recent financing round the cap table shows. Omit when it shows none.',
        properties: {
          date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: 'Closing date, YYYY-MM-DD',
          },
          kind: {
            type: 'string',
            description: 'The round as named, e.g. Seed, Series A',
          },
          raised: number('Amount raised in the round'),
          currency: {
            type: 'string',
            pattern: '^[A-Z]{3}$',
            description: 'ISO 4217 code of the amounts',
          },
          preMoney: number('Pre-money valuation'),
          postMoney: number('Post-money valuation'),
          pricePerShare: number('Price per share'),
          sharesOutstanding: number('Fully diluted shares after the round'),
        },
        required: ['date', 'kind'],
        additionalProperties: false,
      },
      ownership: {
        type: 'object',
        description: 'Our position as the cap table states it',
        properties: {
          ourShares: number('Shares we hold'),
          fullyDilutedShares: number('Fully diluted shares in total'),
          pct: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Our fully diluted ownership, as a fraction of 1',
          },
        },
        additionalProperties: false,
      },
      reason: {
        type: 'string',
        description: 'One sentence: what in the cap table changed.',
      },
    },
    required: ['reason'],
    additionalProperties: false,
  }
}

const TASK = (
  target: LedgerTarget,
  now: HoldingNow,
  workspaceName: string | null,
) =>
  [
    `The text above is the latest revision of "${target.documentName}", the cap table of ${target.companyName}.`,
    `We${workspaceName === null ? '' : ` (${workspaceName})`} hold ${String(now.ourShares)} priced shares in ${target.companyName} on our ledger${now.ownershipPct === null ? '' : `, last known at ${fmtPct(now.ownershipPct)} fully diluted`}.`,
    'Read the most recent financing round the cap table shows and our position in it.',
    'Use only what the cap table states. Omit any field it does not state; never guess.',
  ].join('\n')

// ---------- the choice ----------

const ratio = (part: number | undefined, whole: number | undefined) =>
  part !== undefined && whole !== undefined && whole > 0 ? part / whole : null

const fraction = (pct: number | undefined) =>
  pct !== undefined && pct >= 0 && pct <= 1 ? pct : null

export type LedgerChoice =
  | { event: 'round'; proposed: RoundProposal; afterPct: number | null }
  | { event: 'mark'; proposed: MarkProposal; afterPct: number | null }
  | { event: null; reason: string }

/**
 * One event or none: a round the ledger lacks (by date), else a mark at the
 * round's price on our shares when it differs from the latest mark.
 */
export function chooseLedgerEvent(
  read: CapTableRead,
  now: HoldingNow,
): LedgerChoice {
  const round = read.round
  const ours =
    read.ownership?.ourShares ?? (now.ourShares > 0 ? now.ourShares : undefined)
  const afterPct =
    fraction(read.ownership?.pct) ??
    ratio(ours, round?.sharesOutstanding ?? read.ownership?.fullyDilutedShares)
  if (
    round !== undefined &&
    round.kind.trim() !== '' &&
    !now.roundDates.includes(round.date)
  ) {
    const proposed: RoundProposal = {
      date: round.date,
      kind: round.kind.trim(),
      ...(round.raised === undefined ? {} : { raised: round.raised }),
      ...(round.currency === undefined ? {} : { currency: round.currency }),
      ...(round.preMoney === undefined ? {} : { preMoney: round.preMoney }),
      ...(round.postMoney === undefined ? {} : { postMoney: round.postMoney }),
      ...(round.pricePerShare === undefined
        ? {}
        : { pricePerShare: round.pricePerShare }),
      ...(round.sharesOutstanding === undefined
        ? {}
        : { sharesOutstanding: round.sharesOutstanding }),
    }
    return { event: 'round', proposed, afterPct }
  }
  const price = round?.pricePerShare
  const currency = round?.currency ?? now.currency
  if (round === undefined || price === undefined || ours === undefined)
    return {
      event: null,
      reason:
        'The revision shows no new round and no price to mark our shares at',
    }
  if (currency === null)
    return { event: null, reason: 'No currency to mark in' }
  const fairValue = Math.round(ours * price * 100) / 100
  const held = now.latestMark
  if (held !== null && held.date === round.date && held.fairValue === fairValue)
    return { event: null, reason: 'The holding already carries this mark' }
  return {
    event: 'mark',
    proposed: {
      holdingId: now.holdingId,
      date: round.date,
      fairValue,
      currency,
      basis: 'round_price',
    },
    afterPct,
  }
}

function beforeOf(now: HoldingNow): LedgerBefore {
  return {
    ownershipPct: now.ownershipPct,
    fairValue: now.latestMark?.fairValue ?? null,
    currency: now.latestMark?.currency ?? now.currency,
    roundKind: now.latestRound?.kind ?? null,
    roundDate: now.latestRound?.date ?? null,
  }
}

// ---------- the program ----------

export type LedgerEventInput = {
  documentId: string
  /** The revision the enqueue saw; a newer one has its own job. */
  revisionId: string
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  jobRunId?: string
  runId?: string
}

export type LedgerEventResult =
  | { status: 'proposed'; suggestion: Suggestion }
  | { status: 'skipped'; reason: string }

export const proposeLedgerEventProgram = Effect.fn('proposeLedgerEvent')(
  function* (
    input: LedgerEventInput,
  ): Effect.fn.Return<LedgerEventResult, LedgerEventFailure> {
    const read = yield* query(() => ledgerTargetOf(input.documentId))
    if (!read.ok) return { status: 'skipped', reason: read.reason }
    const { target } = read
    if (target.revisionId !== input.revisionId)
      return {
        status: 'skipped',
        reason: 'A newer revision arrived; its own read proposes',
      }
    const prior = yield* query(() =>
      heldLedgerEvent(db, target.documentId, target.revisionId),
    )
    if (prior)
      return {
        status: 'skipped',
        reason: `Already proposed for this revision (${prior.status}); never proposed twice`,
      }
    return yield* withRun(
      input.runId,
      {
        task: 'Read cap table revision',
        entityId: target.companyId,
        startedBy: { type: 'system' },
      },
      (run) => proposeInRun(input, target, run),
      ledgerEventMessage,
    )
  },
)

const proposeInRun = Effect.fn('proposeLedgerEvent.inRun')(function* (
  input: LedgerEventInput,
  target: LedgerTarget,
  run: RunScope,
): Effect.fn.Return<LedgerEventResult, LedgerEventFailure> {
  const doc = (yield* query(() =>
    db
      .select({
        status: document.extractionStatus,
        text: document.extractedText,
        blobSha: document.blobSha,
        createdAt: document.createdAt,
      })
      .from(document)
      .where(eq(document.entityId, target.documentId)),
  )).at(0)
  const text = doc?.text?.trim().slice(0, LEDGER_EVENT_TEXT_CHARS) ?? ''
  if (!doc || doc.status !== 'done' || text === '')
    return { status: 'skipped', reason: 'The cap table has no extracted text' }

  const now = yield* query(() => holdingNow(target.holdingId))
  const workspaceName =
    (yield* query(() =>
      db.select({ name: workspace.name }).from(workspace),
    )).at(0)?.name ?? null
  const ofDocument = yield* sensitivityFor(target.documentId)
  const ofCompany = yield* sensitivityFor(target.companyId)
  const sensitivity =
    ofCompany.sensitivity === 'sensitive' ? ofCompany : ofDocument

  const runId = yield* run.id
  const cite = ref.doc(target.documentId, 0)
  const items = [
    {
      ref: cite,
      kind: 'doc_chunk' as const,
      text: `${target.documentName}: ${text}`,
      entityIds: [target.documentId],
      at: doc.createdAt.toISOString(),
    },
  ]
  const answered = yield* cachedExtractProgram(
    {
      blobSha: doc.blobSha,
      documentId: target.documentId,
      purpose: LEDGER_EVENT_PURPOSE,
    },
    items,
    outputSchema(),
    {
      // Nobody pressed anything: the revision arrived, as the workspace.
      caller: { type: 'system' },
      sensitivity: sensitivity.sensitivity,
      ...(sensitivity.sensitivity === 'sensitive'
        ? { via: sensitivity.via }
        : {}),
      budgetChars: LEDGER_EVENT_BUDGET_CHARS,
      task: TASK(target, now, workspaceName),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
      runId,
    },
  )
  const step = (outputRef: string | null) =>
    run.step(callStep('extract', [cite], answered, outputRef, input.jobRunId))

  const parsed = capTableReadSchema.safeParse(
    answered.output.kind === 'object' ? answered.output.object : undefined,
  )
  if (!parsed.success) {
    yield* step(null)
    return {
      status: 'skipped',
      reason: 'The model answered in no shape a cap table can be read from',
    }
  }
  const choice = chooseLedgerEvent(parsed.data, now)
  if (choice.event === null) {
    yield* step(null)
    return { status: 'skipped', reason: choice.reason }
  }

  const base = {
    companyId: target.companyId,
    companyName: target.companyName,
    documentId: target.documentId,
    documentName: target.documentName,
    revisionId: target.revisionId,
    before: beforeOf(now),
    after: { ownershipPct: choice.afterPct },
  }
  const payload: LedgerEventPayload =
    choice.event === 'round'
      ? { ...base, event: 'round', proposed: choice.proposed }
      : { ...base, event: 'mark', proposed: choice.proposed }
  // Built from decoded numbers and strings, so this decode is the type's
  // claim made once, not a filter that bites.
  const json = jsonValue.safeParse(payload)
  if (!json.success) {
    yield* step(null)
    return { status: 'skipped', reason: 'The proposal is not JSON' }
  }
  const reason = parsed.data.reason?.trim()
  const proposed = yield* proposeProgram({
    entityId: target.companyId,
    kind: 'ledger_event',
    payload: json.data,
    rationale: [
      `Read from a new revision of ${target.documentName}.`,
      reason === undefined || reason === '' ? null : reason,
      `Accepting appends one ${choice.event} to ${target.companyName}’s ledger; nothing on it is edited.`,
    ]
      .filter((l) => l !== null)
      .join('\n'),
    refs: [cite],
    runId,
    proposedBy: { type: 'system' },
  })
  yield* step(suggestionOutputRef(proposed.id))
  return { status: 'proposed', suggestion: proposed }
})
