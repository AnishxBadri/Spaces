import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import {
  entity,
  interaction,
  interactionEntity,
  note,
  suggestion,
} from '@spaces/db/schema'
import { JSON_SCHEMA_DRAFT } from '@spaces/core/ai/schema'
import type { JsonSchema } from '@spaces/core/ai/schema'
import { ref } from '@spaces/core/context/ref'
import type { ContextItem } from '@spaces/core/context/types'
import { proposeProgram } from '@spaces/core/writes/suggestions/propose'
import { completeMessage, completeProgram } from './complete'
import type { CompleteFailure, CompleteOutput } from './complete'
import { sensitivityFor } from './sensitivity-for'
import type { SensitivityReadFailed } from './sensitivity-for'
import type { SensitivityVia } from './sensitivity'

/**
 * A recorded note's action items (D78): the Extract lane reads the shared
 * note a recorder filed and proposes one `task` suggestion per item, each
 * citing the note, the meeting and the receipt.
 * - Under the sensitivity gate: a meeting whose records or note resolve
 *   sensitive extracts locally, or proposes nothing.
 * - Once per note: a note any task suggestion already cites is skipped, so a
 *   retried job never proposes twice.
 * - The task is about the meeting's company, else its first person.
 */

/** The note's head the model reads; a summary's action items are in it. */
const HEAD_CHARS = 12_000
const BUDGET_CHARS = 14_000
/** More than this is a transcript, not a list of action items. */
const MAX_ITEMS = 20

export class RecordedNoteTasksQueryFailed extends Schema.TaggedError<RecordedNoteTasksQueryFailed>()(
  'RecordedNoteTasksQueryFailed',
  { cause: Schema.Defect() },
) {}

/** A proposal was refused or not written; the job retries the whole note. */
export class RecordedNoteTasksProposeFailed extends Schema.TaggedError<RecordedNoteTasksProposeFailed>()(
  'RecordedNoteTasksProposeFailed',
  { cause: Schema.Defect() },
) {}

/** What stops a run: everything but a refused or unrouted lane. */
export type RecordedNoteTasksFailure =
  | RecordedNoteTasksQueryFailed
  | RecordedNoteTasksProposeFailed
  | SensitivityReadFailed
  | Exclude<
      CompleteFailure,
      { _tag: 'SensitiveRouteRefused' | 'LaneNotRouted' }
    >

/**
 * - `refused`: the meeting is sensitive and the lane is not routed local.
 * - `unrouted`: no model is routed for the lane at this sensitivity.
 */
export type RecordedNoteTasksResult =
  | { status: 'skipped'; reason: string }
  | { status: 'refused' }
  | { status: 'unrouted' }
  | { status: 'proposed'; suggestionIds: Array<string> }

export type RecordedNoteTasksInput = {
  interactionId: string
  noteId: string
  /** The recorder: the suggestions' proposer. */
  integrationId: string
  /** The receipt the note was stored in; removal finds the tasks by it. */
  receiptId: string
  /** The test seam: an injected model answers the lane. */
  model?: LanguageModel
  jobRunId?: string
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RecordedNoteTasksQueryFailed({ cause }),
  })

/** The sentence a failed run leaves on its job. */
export function recordedNoteTasksMessage(
  failure: RecordedNoteTasksFailure,
): string {
  switch (failure._tag) {
    case 'RecordedNoteTasksQueryFailed':
      return 'Could not read the meeting note'
    case 'SensitivityReadFailed':
      return 'Could not read the meeting’s sensitivity'
    case 'RecordedNoteTasksProposeFailed':
      return 'Could not propose the action items'
    default:
      return completeMessage(failure)
  }
}

const TASK = [
  'List the action items in the meeting notes above: what someone agreed to do after the meeting.',
  'One item per action, phrased as a short task (at most 15 words).',
  'Give `due` as YYYY-MM-DD only when the notes state a date; otherwise leave it out.',
  'List none when the notes hold no action items.',
].join('\n')

function itemsSchema(): JsonSchema {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    title: 'action items',
    type: 'object',
    properties: {
      items: {
        type: 'array',
        maxItems: MAX_ITEMS,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            due: { type: 'string' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  }
}

const itemsAnswer = z.object({
  items: z.array(
    z.object({
      title: z.string(),
      due: z.string().nullable().optional().catch(null),
    }),
  ),
})

type Answer =
  | { kind: 'answered'; output: CompleteOutput }
  | { kind: 'refused' }
  | { kind: 'unrouted' }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** The items an answer names, trimmed, deduped and capped; null when it is no answer. */
export function actionItemsOf(
  answer: unknown,
): Array<{ title: string; due: string | null }> | null {
  const parsed = itemsAnswer.safeParse(answer)
  if (!parsed.success) return null
  const seen = new Set<string>()
  const out: Array<{ title: string; due: string | null }> = []
  for (const item of parsed.data.items) {
    const title = item.title.trim().replace(/\s+/g, ' ').slice(0, 500)
    if (title === '' || seen.has(title.toLowerCase())) continue
    seen.add(title.toLowerCase())
    const due = item.due?.trim() ?? null
    out.push({ title, due: due !== null && ISO_DAY.test(due) ? due : null })
  }
  return out.slice(0, MAX_ITEMS)
}

/** The gate: the first of the records, then the note, that resolves sensitive decides. */
const meetingSensitivity = Effect.fn('recordedNoteTasks.sensitivity')(
  function* (
    ids: ReadonlyArray<string>,
  ): Effect.fn.Return<
    { sensitive: boolean; via: SensitivityVia | null },
    SensitivityReadFailed
  > {
    for (const id of ids) {
      const read = yield* sensitivityFor(id).pipe(
        Effect.catchTag('SensitivityEntityNotFound', () =>
          Effect.succeed(null),
        ),
      )
      if (read?.sensitivity === 'sensitive')
        return { sensitive: true, via: read.via }
    }
    return { sensitive: false, via: null }
  },
)

export const recordedNoteTasksProgram = Effect.fn('recordedNoteTasks')(
  function* (
    input: RecordedNoteTasksInput,
  ): Effect.fn.Return<RecordedNoteTasksResult, RecordedNoteTasksFailure> {
    const { interactionId, noteId } = input
    const held = (yield* query(() =>
      db
        .select({
          title: note.title,
          body: note.bodyMd,
          visibility: note.visibility,
          occurredAt: interaction.occurredAt,
        })
        .from(note)
        .innerJoin(interaction, eq(interaction.id, interactionId))
        .where(eq(note.entityId, noteId)),
    )).at(0)
    if (!held)
      return { status: 'skipped', reason: 'The note or the meeting is gone' }
    // Only what everyone may read is read for everyone's Review.
    if (held.visibility !== 'shared')
      return { status: 'skipped', reason: 'Only a shared note is read' }
    const head = held.body.trim().slice(0, HEAD_CHARS)
    if (head === '') return { status: 'skipped', reason: 'The note is empty' }

    const cited = yield* query(() =>
      db
        .select({ id: suggestion.id })
        .from(suggestion)
        .where(
          and(
            eq(suggestion.kind, 'task'),
            sql`${suggestion.refs} @> array[${ref.note(noteId)}]::text[]`,
          ),
        )
        .limit(1),
    )
    if (cited.length > 0)
      return { status: 'skipped', reason: 'Its action items were proposed' }

    const records = yield* query(() =>
      db
        .select({ id: entity.id, kind: entity.kind })
        .from(interactionEntity)
        .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
        .where(
          and(
            eq(interactionEntity.interactionId, interactionId),
            inArray(entity.kind, ['company', 'person']),
            isNull(entity.mergedIntoId),
          ),
        )
        .orderBy(asc(entity.canonicalName)),
    )
    const about = records.find((r) => r.kind === 'company') ?? records.at(0)
    if (about === undefined)
      return { status: 'skipped', reason: 'The meeting names no record' }

    const gate = yield* meetingSensitivity([
      ...records.map((r) => r.id),
      noteId,
    ])
    const items: Array<ContextItem> = [
      {
        ref: ref.note(noteId),
        kind: 'note',
        text: `${held.title}\n\n${head}`,
        entityIds: records.map((r) => r.id),
        at: held.occurredAt.toISOString(),
      },
    ]
    const answered = yield* completeProgram('extract', items, itemsSchema(), {
      // Nobody pressed anything: the lane runs off the arrival, as the
      // workspace, on the workspace's key.
      caller: { type: 'system' },
      sensitivity: gate.sensitive ? 'sensitive' : 'normal',
      ...(gate.via === null ? {} : { via: gate.via }),
      budgetChars: BUDGET_CHARS,
      task: TASK,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
    }).pipe(
      Effect.map((r): Answer => ({ kind: 'answered', output: r.output })),
      Effect.catchTags({
        SensitiveRouteRefused: () =>
          Effect.succeed<Answer>({ kind: 'refused' }),
        LaneNotRouted: () => Effect.succeed<Answer>({ kind: 'unrouted' }),
      }),
    )
    if (answered.kind !== 'answered') return { status: answered.kind }
    const picked = actionItemsOf(
      answered.output.kind === 'object' ? answered.output.object : undefined,
    )
    if (picked === null)
      return { status: 'skipped', reason: 'The model named no action items' }

    const suggestionIds: Array<string> = []
    for (const item of picked) {
      const proposed = yield* proposeProgram({
        entityId: about.id,
        kind: 'task',
        payload: { title: item.title, due: item.due, entity_id: about.id },
        refs: [
          ref.note(noteId),
          ref.interaction(interactionId),
          ref.event(input.receiptId),
        ],
        proposedBy: { type: 'integration', id: input.integrationId },
      }).pipe(
        Effect.mapError(
          (cause) => new RecordedNoteTasksProposeFailed({ cause }),
        ),
      )
      suggestionIds.push(proposed.id)
    }
    return { status: 'proposed', suggestionIds }
  },
)
