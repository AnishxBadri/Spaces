import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { entity, entitySpace, space, suggestion } from '@spaces/db/schema'
import { readSpaceTagPayload } from '@spaces/core/ai/space-tag'
import type { SpaceTagPayload } from '@spaces/core/ai/space-tag'
import { JSON_SCHEMA_DRAFT } from '@spaces/core/ai/schema'
import type { JsonSchema } from '@spaces/core/ai/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import { recordContextProgram } from '@spaces/core/writes/context/record'
import { SimilarLaneLive } from './similar'
import type { ContextItem } from '@spaces/core/context/types'
import { completeMessage, completeProgram, laneTargetProgram } from './complete'
import { callStep, suggestionOutputRef, withRun } from './run'
import type { RunScope } from './run'
import type { CompleteFailure, SensitiveRouteRefused } from './complete'
import { proposeProgram, suggestionMessage } from './propose'
import type { Suggestion, SuggestionFailure } from './propose'
import { providerFailure } from './providers/test-call'
import type { LaneNotRouted, RouteReadFailed } from './route'
import { sensitivityFor } from './sensitivity-for'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'

/**
 * Space-tag suggestions (SPA-103) — the first `entity_space` writer that is
 * not a person, and even so it writes none: "Suggest spaces" on a record's
 * Spaces rail asks `complete('classify')` which spaces of the live tree the
 * record belongs in, and each answer becomes one `suggestion(kind:
 * 'space_tag')` carrying the model's confidence. Accepting one in /inbox is
 * what tags the record (`acceptProgram` → `insertSpaceTag`, `source: 'ai'`,
 * `created_by` the accepter). CONTEXT.md: AI tags land in a review queue,
 * never silently written.
 *
 * **The vocabulary is the `space` table's**, as kind classify's is the
 * `document_kind` enum's: the JSON schema's enum is the live tree's space
 * ids — minus the spaces the record already carries and the ones a
 * suggestion has already been made for — read at run time, never a list in
 * a prompt string. The task names each id with its path so the model can
 * read the tree.
 *
 * **Validate, don't trust.** An answer naming an id absent from the tree, a
 * space the record already carries, one already proposed or rejected, or the
 * same space twice is dropped and counted in the rationale — never written,
 * never failing the run. When nothing is left, no row is written and the
 * run ends without raising.
 *
 * **One proposal per (record, space), ever.** A `space_tag` suggestion that
 * exists for the pair in any status is the answer: a rejection keeps that
 * space out of every later run for this record, as a dismissed duplicate
 * pair or a rejected document kind does.
 *
 * **Manual and pull-based** (spec §4). The run is a worker job, as Read
 * deck's is: a model call is a provider's latency, which must not be
 * somebody's request (`@spaces/core/queue/names`). The press is checked
 * first, though — the record's sensitivity against the classify lane's
 * target, through `complete()`'s own policy half (`laneTargetProgram`) — so
 * a record under a sensitive space on a cloud-routed lane is refused at the
 * button, naming the space, rather than a job later. The job's `complete()`
 * applies the same policy again at run time.
 */

/** The record's context the model reads beside the tree. */
export const SUGGEST_SPACES_CONTEXT_CHARS = 10_000
/** At most this many spaces proposed by one run. */
export const SUGGEST_SPACES_MAX = 5

export class SuggestSpacesRefused extends Schema.TaggedError<SuggestSpacesRefused>()(
  'SuggestSpacesRefused',
  { message: Schema.String },
) {}

export class SuggestSpacesQueryFailed extends Schema.TaggedError<SuggestSpacesQueryFailed>()(
  'SuggestSpacesQueryFailed',
  { cause: Schema.Defect() },
) {}

export type SuggestSpacesFailure =
  | SuggestSpacesRefused
  | SuggestSpacesQueryFailed
  | CompleteFailure
  | SuggestionFailure
  | SensitivityReadFailed
  | SensitivityEntityNotFound

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SuggestSpacesQueryFailed({ cause }),
  })

/** The sentence a refused press or a failed run is shown. */
export function suggestSpacesMessage(failure: SuggestSpacesFailure): string {
  switch (failure._tag) {
    case 'SuggestSpacesRefused':
      return failure.message
    case 'SuggestSpacesQueryFailed':
      return 'Could not read the record or the space tree'
    case 'SensitivityReadFailed':
      return 'Could not read the record’s sensitivity'
    case 'SensitivityEntityNotFound':
      return 'That record is gone'
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
      // Every other failure is `complete()`'s — the unrouted lane, the
      // sensitive refusal naming the space, a cap.
      return completeMessage(failure)
  }
}

// ---------- the tree ----------

export type TreeSpace = { id: string; path: string; label: string }

/**
 * Every live space, each labelled by its path of names ("Energy / Storage /
 * Grid batteries"): `space.path` is an ltree of slugs, so a label is the
 * names of the spaces at each of its prefixes.
 */
const readTree = () =>
  query(async (): Promise<Array<TreeSpace>> => {
    const rows = await db
      .select({
        id: space.entityId,
        path: space.path,
        name: entity.canonicalName,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(isNull(entity.mergedIntoId))
      .orderBy(asc(space.path))
    const nameAt = new Map(rows.map((r) => [r.path, r.name]))
    return rows.map((r) => {
      const segments = r.path.split('.')
      const names = segments.map(
        (_, i) => nameAt.get(segments.slice(0, i + 1).join('.')) ?? r.name,
      )
      return { id: r.id, path: r.path, label: names.join(' / ') }
    })
  })

/** The answer's shape, read leniently: the ids are checked after. */
const answerSchema = z.object({
  spaces: z.array(
    z.object({
      spaceId: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
  reason: z.string().optional(),
})

function outputSchema(options: ReadonlyArray<TreeSpace>): JsonSchema {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    title: 'space tags',
    type: 'object',
    properties: {
      spaces: {
        type: 'array',
        description: `The spaces this record belongs in, most likely first; at most ${String(SUGGEST_SPACES_MAX)}. Empty when none fits.`,
        maxItems: SUGGEST_SPACES_MAX,
        items: {
          type: 'object',
          properties: {
            spaceId: { type: 'string', enum: options.map((o) => o.id) },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['spaceId', 'confidence'],
          additionalProperties: false,
        },
      },
      reason: {
        type: 'string',
        description: 'One or two sentences: what in the record placed it.',
      },
    },
    required: ['spaces', 'reason'],
    additionalProperties: false,
  }
}

const TASK = (name: string, options: ReadonlyArray<TreeSpace>) =>
  [
    `Which of these spaces does "${name}" belong in? A space is a market, sector or theme the fund tracks; a record may sit in several, or in none.`,
    'Spaces (id — path):',
    ...options.map((o) => `${o.id} — ${o.label}`),
    `Answer with at most ${String(SUGGEST_SPACES_MAX)} space ids from the list, most likely first, each with a confidence between 0 and 1, and give a short reason. Propose only spaces the context above supports.`,
  ].join('\n')

// ---------- the run (worker) ----------

export type SuggestSpacesInput = {
  entityId: string
  /** Who pressed Suggest spaces — `ai_usage.caller`, and whose context is read. */
  userId: string
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  /** ISO 8601; defaults to now. */
  asOf?: string
  jobRunId?: string
  /** A run this is a step of (SPA-100); absent, it opens its own. */
  runId?: string
}

export type SuggestSpacesResult = {
  suggestions: Array<Suggestion>
  /** Answers dropped at validate time, each with why. */
  dropped: Array<{ spaceId: string; why: string }>
  /** Set when the run wrote nothing, with why. */
  skipped: string | null
}

type Subject = { id: string; kind: string; name: string }

const readRecord = (entityId: string) =>
  query(async (): Promise<Subject | null> => {
    const row = (
      await db
        .select({
          id: entity.id,
          kind: entity.kind,
          name: entity.canonicalName,
          mergedIntoId: entity.mergedIntoId,
        })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0)
    if (!row) return null
    if (row.mergedIntoId === null) return row
    // A merged-away record's tags belong on its survivor.
    const survivor = (
      await db
        .select({
          id: entity.id,
          kind: entity.kind,
          name: entity.canonicalName,
        })
        .from(entity)
        .where(eq(entity.id, row.mergedIntoId))
    ).at(0)
    return survivor ?? null
  })

const recordOrRefuse = Effect.fn('suggestSpaces.record')(function* (
  entityId: string,
): Effect.fn.Return<Subject, SuggestSpacesRefused | SuggestSpacesQueryFailed> {
  const record = yield* readRecord(entityId)
  if (record === null)
    return yield* new SuggestSpacesRefused({ message: 'That record is gone' })
  if (record.kind === 'space')
    return yield* new SuggestSpacesRefused({
      message: 'A space is placed in the tree, not tagged into it',
    })
  return record
})

/** The spaces the record is tagged into now, by any source. */
const carriedBy = (entityId: string) =>
  query(async () => {
    const rows = await db
      .select({ spaceId: entitySpace.spaceId })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, entityId))
    return new Set(rows.map((r) => r.spaceId))
  })

/**
 * The spaces a `space_tag` suggestion already names for this record, with
 * its status — open, accepted or rejected. Any of them keeps the space out
 * of every later run.
 */
const decidedFor = (entityId: string) =>
  query(async () => {
    const rows = await db
      .select({ payload: suggestion.payload, status: suggestion.status })
      .from(suggestion)
      .where(
        and(
          eq(suggestion.entityId, entityId),
          eq(suggestion.kind, 'space_tag'),
        ),
      )
    const out = new Map<string, string>()
    for (const r of rows) {
      const p = readSpaceTagPayload(r.payload)
      if (p !== null) out.set(p.spaceId, r.status)
    }
    return out
  })

export const suggestSpacesProgram = Effect.fn('suggestSpaces')(function* (
  input: SuggestSpacesInput,
): Effect.fn.Return<SuggestSpacesResult, SuggestSpacesFailure> {
  return yield* withRun(
    input.runId,
    {
      task: 'Suggest spaces',
      entityId: input.entityId,
      startedBy: { type: 'user', id: input.userId },
    },
    (run) => suggestSpacesInRun(input, run),
    suggestSpacesMessage,
  )
})

const suggestSpacesInRun = Effect.fn('suggestSpaces.inRun')(function* (
  input: SuggestSpacesInput,
  run: RunScope,
): Effect.fn.Return<SuggestSpacesResult, SuggestSpacesFailure> {
  const record = yield* recordOrRefuse(input.entityId)
  const [tree, carried, decided] = yield* Effect.all([
    readTree(),
    carriedBy(record.id),
    decidedFor(record.id),
  ])
  const options = tree.filter((s) => !carried.has(s.id) && !decided.has(s.id))
  if (options.length === 0)
    return {
      suggestions: [],
      dropped: [],
      skipped:
        tree.length === 0
          ? 'There are no spaces to suggest'
          : `${record.name} is in, or has been offered, every space already`,
    }

  const context = yield* recordContextProgram({
    entityId: record.id,
    user: { id: input.userId },
    asOf: input.asOf ?? new Date().toISOString(),
    budgetChars: SUGGEST_SPACES_CONTEXT_CHARS,
  }).pipe(
    Effect.provide(SimilarLaneLive),
    Effect.mapError((cause) => new SuggestSpacesQueryFailed({ cause })),
  )
  const items: Array<ContextItem> = context.items.map((i) => ({
    ref: i.ref,
    kind: i.kind,
    text: i.text,
    entityIds: [record.id],
    at: i.at,
  }))

  const task = TASK(record.name, options)
  const sensitivity = yield* sensitivityFor(record.id)
  const runId = yield* run.id
  const answered = yield* completeProgram(
    'classify',
    items,
    outputSchema(options),
    {
      caller: { type: 'user', id: input.userId },
      sensitivity: sensitivity.sensitivity,
      ...(sensitivity.sensitivity === 'sensitive'
        ? { via: sensitivity.via }
        : {}),
      // The context's share plus the whole task: the tree is never cut.
      budgetChars: SUGGEST_SPACES_CONTEXT_CHARS + task.length + 2,
      task,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
      runId,
    },
  )
  const step = (outputRef: string | null) =>
    run.step(
      callStep(
        'classify',
        items.map((i) => i.ref),
        answered,
        outputRef,
        input.jobRunId,
      ),
    )

  const parsed = answerSchema.safeParse(
    answered.output.kind === 'object' ? answered.output.object : undefined,
  )
  const { picks, dropped } = keepValid(
    parsed.success ? parsed.data.spaces : [],
    { tree, carried, decided },
  )
  const droppedLine =
    dropped.length === 0
      ? null
      : `Dropped ${String(dropped.length)} answer${dropped.length === 1 ? '' : 's'}: ${dropped.map((d) => d.why).join('; ')}.`

  if (picks.length === 0) {
    yield* step(null)
    return {
      suggestions: [],
      dropped,
      skipped: [
        parsed.success
          ? 'The model placed the record in no space it may propose'
          : 'The model answered in no shape a space can be read from',
        droppedLine,
      ]
        .filter((l) => l !== null)
        .join('. '),
    }
  }

  const reason = parsed.success ? parsed.data.reason?.trim() : undefined
  const refs = context.items.map((i) => i.ref)
  const suggestions: Array<Suggestion> = []
  for (const pick of picks) {
    const rationale = [
      `Read from ${record.name}’s record against the space tree: it looks like it belongs in ${pick.label}.`,
      reason === undefined || reason === '' ? null : reason,
      droppedLine,
      'Accepting tags the record into the space; nothing else runs.',
    ]
      .filter((l) => l !== null)
      .join('\n')
    suggestions.push(
      yield* proposeProgram({
        entityId: record.id,
        kind: 'space_tag',
        payload: pick,
        rationale,
        refs,
        runId,
        proposedBy: { type: 'user', id: input.userId },
      }),
    )
  }
  const out = suggestions.at(0)
  yield* step(out === undefined ? null : suggestionOutputRef(out.id))
  return { suggestions, dropped, skipped: null }
})

/**
 * The validator: every answer held to the tree as it stands now. Pure over
 * its inputs, so the dropping rule is one function a test can hold.
 */
export function keepValid(
  answers: ReadonlyArray<{ spaceId: string; confidence?: number | undefined }>,
  held: {
    tree: ReadonlyArray<TreeSpace>
    carried: ReadonlySet<string>
    decided: ReadonlyMap<string, string>
  },
): {
  picks: Array<SpaceTagPayload>
  dropped: Array<{ spaceId: string; why: string }>
} {
  const byId = new Map(held.tree.map((s) => [s.id, s]))
  const picks: Array<SpaceTagPayload> = []
  const dropped: Array<{ spaceId: string; why: string }> = []
  for (const a of answers) {
    const found = byId.get(a.spaceId)
    if (found === undefined) {
      dropped.push({
        spaceId: a.spaceId,
        why: `${JSON.stringify(a.spaceId)} is not a space in the tree`,
      })
      continue
    }
    const status = held.decided.get(a.spaceId)
    const why = held.carried.has(a.spaceId)
      ? `${found.label} is a space the record already carries`
      : status !== undefined
        ? `${found.label} was already proposed (${status})`
        : picks.some((p) => p.spaceId === a.spaceId)
          ? `${found.label} was named twice`
          : picks.length >= SUGGEST_SPACES_MAX
            ? `${found.label} is past the first ${String(SUGGEST_SPACES_MAX)}`
            : null
    if (why !== null) {
      dropped.push({ spaceId: a.spaceId, why })
      continue
    }
    picks.push(
      a.confidence === undefined
        ? { spaceId: found.id, label: found.label }
        : { spaceId: found.id, label: found.label, confidence: a.confidence },
    )
  }
  return { picks, dropped }
}

// ---------- trigger + status (the rail's two server fns) ----------

export type SuggestSpacesEnqueued =
  | { status: 'queued' }
  | { status: 'already-running' }
  | { status: 'queue-unavailable' }

/**
 * Press Suggest spaces: the lane's policy checked at the button, then one
 * job keyed on the record. The queue is `exclusive`, so pg-boss refuses a
 * second send while one is queued or active; the jobs read back tell that
 * refusal from a queue that is down.
 */
export const enqueueSuggestSpacesProgram = Effect.fn('enqueueSuggestSpaces')(
  function* (
    entityId: string,
    userId: string,
  ): Effect.fn.Return<
    SuggestSpacesEnqueued,
    | SuggestSpacesRefused
    | SuggestSpacesQueryFailed
    | SensitivityReadFailed
    | SensitivityEntityNotFound
    | LaneNotRouted
    | RouteReadFailed
    | SensitiveRouteRefused
  > {
    const record = yield* recordOrRefuse(entityId)
    const sensitivity = yield* sensitivityFor(record.id)
    // `complete()`'s own policy half: an unrouted lane, or a sensitive
    // record on a cloud route — the refusal names the space it came from.
    const target = yield* Effect.result(
      laneTargetProgram('classify', {
        sensitivity: sensitivity.sensitivity,
        ...(sensitivity.sensitivity === 'sensitive'
          ? { via: sensitivity.via }
          : {}),
      }),
    )
    if (target._tag === 'Failure') {
      const failure = target.failure
      // A sensitive record with no sensitive-scope route: say where the
      // sensitivity came from, as the cloud refusal does.
      if (
        failure._tag === 'LaneNotRouted' &&
        sensitivity.sensitivity === 'sensitive' &&
        sensitivity.via.kind === 'space'
      )
        return yield* new SuggestSpacesRefused({
          message: `${record.name} is sensitive (inherited from ${sensitivity.via.name}); no local model is routed for the classify lane`,
        })
      return yield* Effect.fail(failure)
    }
    const jobId = yield* query(() =>
      enqueue(
        QUEUES.suggestSpaces,
        { entityId: record.id, userId },
        { singletonKey: record.id },
      ),
    )
    if (jobId !== null) return { status: 'queued' }
    const jobs = yield* query(() => jobsByKey(QUEUES.suggestSpaces, record.id))
    return jobs !== null && jobs.some(inFlight)
      ? { status: 'already-running' }
      : { status: 'queue-unavailable' }
  },
)

export type SuggestSpacesRefusal = { status: 'refused'; message: string }

/**
 * The press, as the server fn runs it: every refusal becomes a sentence the
 * rail's toast prints — the sensitive one naming the space — so the one
 * Effect seam (`effectFn`) rejects only on a defect.
 */
export const pressSuggestSpacesProgram = Effect.fn('pressSuggestSpaces')(
  function* (
    entityId: string,
    userId: string,
  ): Effect.fn.Return<SuggestSpacesEnqueued | SuggestSpacesRefusal> {
    return yield* enqueueSuggestSpacesProgram(entityId, userId).pipe(
      Effect.catch((failure) => {
        const refused: SuggestSpacesRefusal = {
          status: 'refused',
          message: suggestSpacesMessage(failure),
        }
        return Effect.succeed(refused)
      }),
    )
  },
)

const inFlight = (j: QueuedJob): boolean =>
  j.state === 'created' || j.state === 'retry' || j.state === 'active'

export type SuggestSpacesStatus =
  | { state: 'idle' }
  | { state: 'running' }
  /** `proposed`: the space tags this run wrote — zero when it found none. */
  | { state: 'done'; at: string; proposed: number }
  | { state: 'failed'; message: string; at: string }

/** The wrapper's `JobOutcome.reason`, read off a settled job's output. */
function reasonOf(output: object | null): string | null {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/**
 * The latest job for a record, as the rail reads it. A completed run's
 * output is the wrapper's `ok`, so what it wrote is counted instead: the
 * record's `space_tag` rows made since the job was queued.
 */
export function suggestSpacesStatusOf(
  jobs: ReadonlyArray<QueuedJob>,
  proposedSince: (since: Date) => number,
): SuggestSpacesStatus {
  const latest = [...jobs]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)
  if (latest === undefined) return { state: 'idle' }
  if (inFlight(latest)) return { state: 'running' }
  const at = latest.createdOn.toISOString()
  if (latest.state === 'completed')
    return { state: 'done', at, proposed: proposedSince(latest.createdOn) }
  return {
    state: 'failed',
    message: reasonOf(latest.output) ?? 'Spaces could not be suggested',
    at,
  }
}

export const suggestSpacesStatusProgram = Effect.fn('suggestSpacesStatus')(
  function* (
    entityId: string,
  ): Effect.fn.Return<SuggestSpacesStatus, SuggestSpacesQueryFailed> {
    const jobs = yield* query(() => jobsByKey(QUEUES.suggestSpaces, entityId))
    if (jobs === null) return { state: 'idle' }
    const made = yield* query(() =>
      db
        .select({ createdAt: suggestion.createdAt })
        .from(suggestion)
        .where(
          and(
            eq(suggestion.entityId, entityId),
            eq(suggestion.kind, 'space_tag'),
          ),
        ),
    )
    return suggestSpacesStatusOf(
      jobs,
      (since) => made.filter((m) => m.createdAt >= since).length,
    )
  },
)
