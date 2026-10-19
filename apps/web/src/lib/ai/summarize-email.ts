import { Effect, Schema } from 'effect'
import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { interaction, interactionEntity, note } from '@spaces/db/schema'
import type { InteractionMeta } from '@spaces/db/schema'
import { JSON_SCHEMA_DRAFT } from '@spaces/core/ai/schema'
import type { JsonSchema } from '@spaces/core/ai/schema'
import { ref } from '@spaces/core/context/ref'
import type { ContextItem } from '@spaces/core/context/types'
import {
  EMAIL_CATEGORIES,
  EMAIL_CATEGORIES_MAX,
  clean,
  isEmailCategory,
} from '@spaces/core/interactions/email-listing'
import type { EmailCategory } from '@spaces/core/interactions/email-listing'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'
import { completeMessage, completeProgram } from './complete'
import type { CompleteFailure } from './complete'
import type { AiLane } from './lanes'
import { sensitivityFor } from './sensitivity-for'
import type { SensitivityReadFailed } from './sensitivity-for'
import type { SensitivityVia } from './sensitivity'

/**
 * An email's cached display text (D67): a one-line summary through the
 * synthesize lane and category labels through the classify lane, written to
 * `interaction.meta.summary` / `meta.categories`.
 * - Under the sensitivity gate: any record the email is edged to, or its
 *   body, resolving sensitive makes both calls sensitive — routed local, or
 *   refused and the field left absent, so the row shows the snippet.
 * - Never a proposal, never an attribute, and written once: each update is
 *   guarded on the field being absent, so a lane's answer is never rewritten.
 * - Only emails a mail lane wrote (meta present); a hand-logged email has none.
 */

/** The body's head the model reads: a summary is in the first screen. */
export const SUMMARIZE_EMAIL_HEAD_CHARS = 6_000
const BUDGET_CHARS = 8_000

export class SummarizeEmailQueryFailed extends Schema.TaggedError<SummarizeEmailQueryFailed>()(
  'SummarizeEmailQueryFailed',
  { cause: Schema.Defect() },
) {}

/** What stops a run: everything but a refused or unrouted lane. */
export type SummarizeEmailFailure =
  | SummarizeEmailQueryFailed
  | SensitivityReadFailed
  | Exclude<
      CompleteFailure,
      { _tag: 'SensitiveRouteRefused' | 'LaneNotRouted' }
    >

/**
 * One half's answer.
 * - `kept`: a lane had already written it.
 * - `refused`: the email is sensitive and the lane is not routed local.
 * - `unrouted`: no model is routed for the lane at this sensitivity.
 * - `blank`: the model answered nothing usable; nothing written.
 */
export type HalfOutcome = 'written' | 'kept' | 'refused' | 'unrouted' | 'blank'

export type SummarizeEmailResult =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; summary: HalfOutcome; categories: HalfOutcome }

export type SummarizeEmailInput = {
  interactionId: string
  /** The test seam: one injected model answers both lanes. */
  model?: LanguageModel
  jobRunId?: string
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SummarizeEmailQueryFailed({ cause }),
  })

/** The sentence a failed run leaves on its job. */
export function summarizeEmailMessage(failure: SummarizeEmailFailure): string {
  switch (failure._tag) {
    case 'SummarizeEmailQueryFailed':
      return 'Could not read the email'
    case 'SensitivityReadFailed':
      return 'Could not read the email’s sensitivity'
    default:
      return completeMessage(failure)
  }
}

/** One email onto the summarize queue; one queued job per email. Never throws. */
export function enqueueSummarizeEmail(
  interactionId: string,
): Promise<string | null> {
  return enqueue(
    QUEUES.summarizeEmail,
    { interactionId },
    { singletonKey: interactionId },
  )
}

const SUMMARY_TASK = [
  'Summarise the email above in one plain sentence of at most 25 words: what it says or asks.',
  'No preamble, no quotation marks, no names of the fields.',
].join('\n')

const CATEGORY_TASK = [
  'Label the email above with what kind of email it is.',
  `Choose zero to ${String(EMAIL_CATEGORIES_MAX)} of: ${EMAIL_CATEGORIES.join(', ')}.`,
  'Choose none when nothing fits.',
].join('\n')

function categorySchema(): JsonSchema {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    title: 'email categories',
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        maxItems: EMAIL_CATEGORIES_MAX,
        items: { type: 'string', enum: [...EMAIL_CATEGORIES] },
      },
    },
    required: ['categories'],
    additionalProperties: false,
  }
}

const categoryAnswer = z.object({ categories: z.array(z.string()) })

/** The categories an answer names that are categories, deduped, capped. */
export function categoriesOf(answer: unknown): Array<EmailCategory> | null {
  const parsed = categoryAnswer.safeParse(answer)
  if (!parsed.success) return null
  return [...new Set(parsed.data.categories.filter(isEmailCategory))].slice(
    0,
    EMAIL_CATEGORIES_MAX,
  )
}

/**
 * The email's gate: the first of its records, then its body, that resolves
 * sensitive decides, as meeting prep's does.
 */
const emailSensitivity = Effect.fn('summarizeEmail.sensitivity')(function* (
  ids: ReadonlyArray<string>,
): Effect.fn.Return<
  { sensitive: boolean; via: SensitivityVia | null },
  SensitivityReadFailed
> {
  for (const id of ids) {
    const read = yield* sensitivityFor(id).pipe(
      Effect.catchTag('SensitivityEntityNotFound', () => Effect.succeed(null)),
    )
    if (read?.sensitivity === 'sensitive')
      return { sensitive: true, via: read.via }
  }
  return { sensitive: false, via: null }
})

/** Writes `patch` into an email's meta unless `key` is already there. */
const writeOnce = (
  interactionId: string,
  key: 'summary' | 'categories',
  patch: Partial<InteractionMeta>,
) =>
  query(() =>
    db
      .update(interaction)
      .set({
        meta: sql<InteractionMeta>`${interaction.meta} || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(
        and(
          eq(interaction.id, interactionId),
          eq(interaction.kind, 'email'),
          isNotNull(interaction.meta),
          sql`not (${interaction.meta} ? ${key})`,
        ),
      )
      .returning({ id: interaction.id }),
  ).pipe(Effect.map((rows) => (rows.length > 0 ? 'written' : 'kept')))

export const summarizeEmailProgram = Effect.fn('summarizeEmail')(function* (
  input: SummarizeEmailInput,
): Effect.fn.Return<SummarizeEmailResult, SummarizeEmailFailure> {
  const { interactionId } = input
  const row = (yield* query(() =>
    db
      .select({
        kind: interaction.kind,
        subject: interaction.subject,
        meta: interaction.meta,
        occurredAt: interaction.occurredAt,
        noteId: interaction.noteId,
        body: note.bodyMd,
      })
      .from(interaction)
      .leftJoin(note, eq(note.entityId, interaction.noteId))
      .where(eq(interaction.id, interactionId)),
  )).at(0)
  if (!row) return { status: 'skipped', reason: 'That email is gone' }
  const meta = row.meta
  if (row.kind !== 'email' || meta?.kind !== 'email')
    return { status: 'skipped', reason: 'Only a mailed email is summarised' }
  const wantSummary = meta.summary === undefined
  const wantCategories = meta.categories === undefined
  if (!wantSummary && !wantCategories)
    return { status: 'done', summary: 'kept', categories: 'kept' }

  const head = (row.body ?? '').trim().slice(0, SUMMARIZE_EMAIL_HEAD_CHARS)
  if (head === '' && (row.subject ?? '').trim() === '')
    return { status: 'skipped', reason: 'The email has no subject and no body' }

  const edges = yield* query(() =>
    db
      .select({ id: interactionEntity.entityId })
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, interactionId)),
  )
  const gate = yield* emailSensitivity([
    ...edges.map((e) => e.id),
    ...(row.noteId === null ? [] : [row.noteId]),
  ])

  const items: Array<ContextItem> = [
    {
      ref: ref.interaction(interactionId),
      kind: 'interaction',
      text: [
        `Subject: ${row.subject ?? ''}`,
        `From: ${meta.from}`,
        `To: ${[...meta.to, ...meta.cc].join(', ')}`,
        '',
        head,
      ].join('\n'),
      entityIds: edges.map((e) => e.id),
      at: row.occurredAt.toISOString(),
    },
  ]
  const call = (lane: AiLane, task: string, schema: JsonSchema | undefined) =>
    completeProgram(lane, items, schema, {
      // Nobody pressed anything: the lane runs off the arrival, as the
      // workspace, on the workspace's key.
      caller: { type: 'system' },
      sensitivity: gate.sensitive ? 'sensitive' : 'normal',
      ...(gate.via === null ? {} : { via: gate.via }),
      budgetChars: BUDGET_CHARS,
      task,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
    })
  const gated = <TValue>(
    effect: Effect.Effect<
      TValue | HalfOutcome,
      SummarizeEmailFailure | CompleteFailure
    >,
  ): Effect.Effect<TValue | HalfOutcome, SummarizeEmailFailure> =>
    effect.pipe(
      Effect.catchTags({
        SensitiveRouteRefused: () => Effect.succeed<HalfOutcome>('refused'),
        LaneNotRouted: () => Effect.succeed<HalfOutcome>('unrouted'),
      }),
    )

  const summary: HalfOutcome = wantSummary
    ? yield* gated(
        Effect.gen(function* () {
          const answered = yield* call('synthesize', SUMMARY_TASK, undefined)
          const text = clean(
            answered.output.kind === 'text' ? answered.output.text : undefined,
          )
          if (text === null) return 'blank' as const
          return yield* writeOnce(interactionId, 'summary', { summary: text })
        }),
      )
    : 'kept'

  const categories: HalfOutcome = wantCategories
    ? yield* gated(
        Effect.gen(function* () {
          const answered = yield* call(
            'classify',
            CATEGORY_TASK,
            categorySchema(),
          )
          const picked = categoriesOf(
            answered.output.kind === 'object'
              ? answered.output.object
              : undefined,
          )
          if (picked === null) return 'blank' as const
          return yield* writeOnce(interactionId, 'categories', {
            categories: picked,
          })
        }),
      )
    : 'kept'

  return { status: 'done', summary, categories }
})

/** How many emails one backfill page reads. */
export const SUMMARIZE_BACKFILL_PAGE = 50

export type SummarizeBackfillResult = {
  /** Emails a lane wrote a summary or categories for in this run. */
  written: number
  /** Emails read and left as they were: refused, unrouted, or blank. */
  untouched: number
}

/**
 * The backfill: every mailed email missing a summary or categories, a page at
 * a time in id order, through `summarizeEmailProgram`. An email that has
 * them is never selected, and the program's guarded update never rewrites
 * one. Stops at the first failure — the day's cap, a provider down — with
 * what it wrote kept; the next run carries on from what the rows say.
 */
export const summarizeEmailBackfillProgram = Effect.fn(
  'summarizeEmailBackfill',
)(function* (
  input: Omit<SummarizeEmailInput, 'interactionId'> = {},
): Effect.fn.Return<SummarizeBackfillResult, SummarizeEmailFailure> {
  let after: string | null = null
  let written = 0
  let untouched = 0
  for (;;) {
    const cursor: string | null = after
    const page: Array<{ id: string }> = yield* query(() =>
      db
        .select({ id: interaction.id })
        .from(interaction)
        .where(
          and(
            eq(interaction.kind, 'email'),
            isNotNull(interaction.meta),
            sql`not (${interaction.meta} ? 'summary' and ${interaction.meta} ? 'categories')`,
            cursor === null ? undefined : gt(interaction.id, cursor),
          ),
        )
        .orderBy(asc(interaction.id))
        .limit(SUMMARIZE_BACKFILL_PAGE),
    )
    for (const { id } of page) {
      const r = yield* summarizeEmailProgram({ ...input, interactionId: id })
      if (
        r.status === 'done' &&
        (r.summary === 'written' || r.categories === 'written')
      )
        written++
      else untouched++
    }
    const last: { id: string } | undefined = page.at(-1)
    if (last === undefined || page.length < SUMMARIZE_BACKFILL_PAGE)
      return { written, untouched }
    after = last.id
  }
})
