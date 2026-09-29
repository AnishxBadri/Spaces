import { Effect, Schema } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { entity, suggestion } from '@spaces/db/schema'
import {
  AI_MODE_LABEL,
  OPTION_LABEL_MAX,
  optionProposalLine,
  readAiConfig,
  readOptionProposals,
  renderAiPrompt,
} from '@spaces/core/ai/attribute-ai'
import type { AiAttributeConfig } from '@spaces/core/ai/attribute-ai'
import {
  JSON_SCHEMA_DRAFT,
  schemaFor,
  validateProposal,
} from '@spaces/core/ai/schema'
import type { JsonSchema } from '@spaces/core/ai/schema'
import { liveOptions } from '@spaces/core/attributes/options'
import type { AttributeDef } from '@spaces/core/attributes/registry'
import { QUEUES } from '@spaces/core/queue/names'
import { jsonRecord, jsonValue } from '@spaces/core/json'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import { recordContextProgram } from '#/lib/context/record'
import type { ContextItem } from '@spaces/core/context/types'
import { updateAttributeProgram } from '@spaces/core/writes/attributes/update'
import { completeMessage, completeProgram, laneTargetProgram } from './complete'
import type { CompleteFailure, SensitiveRouteRefused } from './complete'
import {
  acceptProgram,
  proposeProgram,
  registryFor,
  suggestionMessage,
} from './propose'
import type { Suggestion, SuggestionFailure } from './propose'
import { providerFailure } from './providers/test-call'
import type { LaneNotRouted, RouteReadFailed } from './route'
import { callStep, suggestionOutputRef, withRun } from './run'
import type { RunScope } from './run'
import { sensitivityFor } from './sensitivity-for'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'

/**
 * AI attributes (SPA-72, docs/spec-ai-substrate.md §13) — one cell at a
 * time. An attribute whose `options.ai` is set (the spec's
 * `attribute.config.ai`; there is no `config` column, so the per-type
 * `options` blob carries it — see `AiAttributeConfig`) grows a trigger on
 * its cell, on the record rail and in the table. Pressing it enqueues one
 * `attribute.run` job for that (record, attribute); the job asks the mode's
 * lane and **proposes** — D41, "AI proposes, a person accepts": the answer
 * is a `suggestion(kind: 'attribute_patch')` through `proposeProgram`,
 * carrying a rationale and refs on every mode, never a value and never a
 * pre-filled control. Accepting it in /inbox is what writes the value, by
 * the accepter, through the one write path.
 *
 * **No AI-specific code per object.** The output schema is `schemaFor`
 * narrowed to the one attribute, so a custom object's attribute is
 * runnable the moment it carries a mode; the context is the assembler
 * (`recordContextProgram` — notes, documents, links, the mandate), not the
 * record's attribute values alone.
 *
 * **A new option is a registry proposal.** A classify answer naming an
 * option the attribute does not have is dropped from the patch and becomes
 * its own suggestion: an empty patch whose rationale opens with
 * `optionProposalLine` (`@spaces/core/ai/attribute-ai`). No suggestion kind
 * is added for it; the inbox card reads the line back and offers "Add
 * option", which goes through the attribute's existing option-list edit
 * (`updateAttributeProgram`) and then closes the proposal as accepted. A
 * label the person rejected before on this cell is not proposed again.
 *
 * **One open proposal per cell.** A cell with an open suggestion naming its
 * attribute — a value or a registry proposal, from this lane or the deck
 * reader — reads "proposed", and a press on it is refused rather than
 * duplicated, at the button and again in the job.
 */

/** The record's context the model reads beside the task. */
export const ATTRIBUTE_RUN_CONTEXT_CHARS = 10_000

export class AttributeRunRefused extends Schema.TaggedError<AttributeRunRefused>()(
  'AttributeRunRefused',
  { message: Schema.String },
) {}

export class AttributeRunQueryFailed extends Schema.TaggedError<AttributeRunQueryFailed>()(
  'AttributeRunQueryFailed',
  { cause: Schema.Defect() },
) {}

export type AttributeRunFailure =
  | AttributeRunRefused
  | AttributeRunQueryFailed
  | CompleteFailure
  | SuggestionFailure
  | SensitivityReadFailed
  | SensitivityEntityNotFound

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AttributeRunQueryFailed({ cause }),
  })

/** The sentence a refused press or a failed run is shown. */
export function attributeRunMessage(failure: AttributeRunFailure): string {
  switch (failure._tag) {
    case 'AttributeRunRefused':
      return failure.message
    case 'AttributeRunQueryFailed':
      return 'Could not read the record or its attribute'
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
      return completeMessage(failure)
  }
}

// ---------- the cell ----------

type Cell = {
  record: {
    id: string
    name: string
    values: { [slug: string]: unknown }
  }
  def: AttributeDef
  registry: Array<AttributeDef>
  ai: AiAttributeConfig
}

const readCell = Effect.fn('attributeRun.cell')(function* (
  entityId: string,
  attributeId: string,
): Effect.fn.Return<Cell, AttributeRunRefused | AttributeRunQueryFailed> {
  const record = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        mergedIntoId: entity.mergedIntoId,
      })
      .from(entity)
      .where(eq(entity.id, entityId))
      .then((rows) => rows.at(0)),
  )
  if (!record)
    return yield* new AttributeRunRefused({ message: 'That record is gone' })
  if (record.mergedIntoId !== null)
    return yield* new AttributeRunRefused({
      message: 'That record was merged; run the cell on the record it became',
    })
  const registry = yield* Effect.tryPromise({
    try: () => registryFor(db, record.id),
    catch: () =>
      new AttributeRunRefused({ message: 'This record has no attributes' }),
  })
  const def = registry.find((d) => d.id === attributeId)
  if (!def || def.archived)
    return yield* new AttributeRunRefused({
      message: 'That attribute is not on this record',
    })
  const ai = readAiConfig(def)
  if (ai === null)
    return yield* new AttributeRunRefused({
      message: `${def.name} is not an AI attribute`,
    })
  return {
    record: { id: record.id, name: record.name, values: record.values },
    def,
    registry,
    ai,
  }
})

/** Does this suggestion name `slug` — as a value, or as a registry proposal? */
export function suggestionNames(
  row: { payload: Parameters<typeof jsonRecord>[0]; rationale: string | null },
  slug: string,
): boolean {
  return (
    slug in jsonRecord(row.payload) ||
    readOptionProposals(row.rationale).some((p) => p.slug === slug)
  )
}

const patchRows = (
  entityIds: ReadonlyArray<string>,
  status: 'open' | 'rejected',
) =>
  query(() =>
    entityIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: suggestion.id,
            entityId: suggestion.entityId,
            payload: suggestion.payload,
            rationale: suggestion.rationale,
            createdAt: suggestion.createdAt,
          })
          .from(suggestion)
          .where(
            and(
              inArray(suggestion.entityId, [...entityIds]),
              eq(suggestion.kind, 'attribute_patch'),
              eq(suggestion.status, status),
            ),
          ),
  )

const openFor = (entityId: string, slug: string) =>
  patchRows([entityId], 'open').pipe(
    Effect.map((rows) => rows.some((r) => suggestionNames(r, slug))),
  )

// ---------- classify: the vocabulary check ----------

export type ClassifySplit = {
  /** What stays in the patch — absent when nothing does. */
  value?: unknown
  /** Labels the model wanted that the attribute does not have. */
  wanted: Array<string>
  /** Why an answer was left out, one line each. */
  dropped: Array<string>
}

/**
 * A classify answer held to the attribute's live options. An id or a label
 * of a live option stays (a label is read as its option's id); an archived
 * option is dropped — history, not vocabulary; anything else is wanted as a
 * new option, which is a registry proposal and never a value. Pure, so the
 * rule is one function a test can hold.
 */
export function splitClassifyValue(
  def: Pick<AttributeDef, 'type' | 'options' | 'name'>,
  value: unknown,
): ClassifySplit {
  if (def.type === 'checkbox')
    return typeof value === 'boolean'
      ? { value, wanted: [], dropped: [] }
      : { wanted: [], dropped: [] }
  const all = def.options.options ?? []
  const live = liveOptions(def)
  const wanted: Array<string> = []
  const dropped: Array<string> = []
  const resolve = (raw: unknown): string | null => {
    if (typeof raw !== 'string' || raw.trim() === '') return null
    const text = raw.trim()
    const lower = text.toLowerCase()
    const byId = live.find((o) => o.id === text)
    if (byId) return byId.id
    const byLabel = live.find((o) => o.label.toLowerCase() === lower)
    if (byLabel) return byLabel.id
    const retired = all.find(
      (o) => o.archived && (o.id === text || o.label.toLowerCase() === lower),
    )
    if (retired) {
      dropped.push(`${retired.label} is an archived option of ${def.name}`)
      return null
    }
    wanted.push(text)
    return null
  }
  if (def.type === 'multi_select') {
    const ids = [
      ...new Set(
        (Array.isArray(value)
          ? value
          : value === null || value === undefined
            ? []
            : [value]
        )
          .map(resolve)
          .filter((id) => id !== null),
      ),
    ]
    return ids.length > 0
      ? { value: ids, wanted, dropped }
      : { wanted, dropped }
  }
  const id = resolve(value)
  return id === null ? { wanted, dropped } : { value: id, wanted, dropped }
}

// ---------- the prompt ----------

/** A stored value as the prompt shows it: option labels, not ids. */
function displayValue(def: AttributeDef, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  const labelOf = (id: unknown) =>
    (def.options.options ?? []).find((o) => o.id === id)?.label ?? String(id)
  if (Array.isArray(raw))
    return raw.length === 0
      ? null
      : raw
          .map((v) =>
            def.type === 'multi_select'
              ? labelOf(v)
              : typeof v === 'string'
                ? v
                : JSON.stringify(v),
          )
          .join(', ')
  if (def.type === 'select' || def.type === 'status') return labelOf(raw)
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

function taskFor(cell: Cell): string {
  const { def, ai, record } = cell
  const values: Record<string, string> = {}
  for (const slug of ai.variables ?? []) {
    const d = cell.registry.find((r) => r.slug === slug)
    const shown = d ? displayValue(d, record.values[slug]) : null
    if (shown !== null) values[slug] = shown
  }
  const guidance = renderAiPrompt(ai.prompt, values).trim()
  const about = `"${record.name}"`
  const lines: Array<string> = []
  switch (ai.mode) {
    case 'classify':
      lines.push(`Classify ${about} for the field "${def.name}".`)
      if (def.type === 'checkbox') lines.push('The value is true or false.')
      else {
        const live = liveOptions(def)
        lines.push(
          live.length === 0
            ? `"${def.name}" has no options yet.`
            : 'Options (id — label):',
          ...live.map((o) => `${o.id} — ${o.label}`),
          `If no listed option fits and one plainly should exist, name it in "newOption" (a short label) and leave the value out; it is proposed to the registry, not written.`,
        )
      }
      break
    case 'summarize':
      lines.push(
        `Write the field "${def.name}" for ${about}: a short summary of what the context says, in plain prose.`,
      )
      break
    case 'prompt':
    case 'research':
      lines.push(
        `Answer for ${about}, as the field "${def.name}" (a ${def.type} value).`,
      )
      break
  }
  if (guidance !== '') lines.push(`Instructions: ${guidance}`)
  lines.push(
    `Put the answer under "${def.slug}" as {value, refs, confidence} — refs are the [ref]s of the context items the answer rests on, confidence between 0 and 1 — and give a short reason. Omit "${def.slug}" when the context does not support an answer.`,
  )
  return lines.join('\n')
}

/** `schemaFor` narrowed to the one attribute, plus the reason (and, for classify, a new option). */
function outputSchema(cell: Cell): JsonSchema {
  const field = schemaFor([cell.def]).properties?.[cell.def.slug]
  const properties: Record<string, JsonSchema> = {}
  if (field !== undefined) properties[cell.def.slug] = field
  if (cell.ai.mode === 'classify' && cell.def.type !== 'checkbox')
    properties.newOption = {
      type: 'string',
      maxLength: OPTION_LABEL_MAX,
      description:
        'Only when no listed option fits: the label of the option that should exist.',
    }
  properties.reason = {
    type: 'string',
    description: 'One or two sentences: what in the context gave the answer.',
  }
  return {
    $schema: JSON_SCHEMA_DRAFT,
    title: cell.def.name,
    type: 'object',
    properties,
    required: ['reason'],
    additionalProperties: false,
  }
}

const answerSchema = z.object({
  reason: z.string().optional(),
  newOption: z.string().optional(),
})

const fieldSchema = z.object({
  value: z.unknown(),
  refs: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
})

// ---------- the run (worker) ----------

export type AttributeRunInput = {
  entityId: string
  attributeId: string
  /** Who pressed the cell — `ai_usage.caller`, and whose context is read. */
  userId: string
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  /** ISO 8601; defaults to now. */
  asOf?: string
  jobRunId?: string
  /**
   * The run this cell is one step of (`./run.ts`, SPA-100) — a column run
   * (SPA-122) threads its one run through every row. Absent, the press is
   * its own one-step run, opened at the model call and closed when the
   * cell settles.
   */
  runId?: string
}

export type AttributeRunResult = {
  /** The value suggestion, then one registry proposal per wanted option. */
  suggestions: Array<Suggestion>
  /** Labels proposed to the registry. */
  proposedOptions: Array<string>
  /** Answers left out, each with why. */
  dropped: Array<string>
  /** Set when the run wrote nothing, with why. */
  skipped: string | null
}

/** What the Usage page lists a per-cell run as, before the attribute's name. */
export const ATTRIBUTE_RUN_TASK = 'AI attribute'

export const attributeRunProgram = Effect.fn('attributeRun')(function* (
  input: AttributeRunInput,
): Effect.fn.Return<AttributeRunResult, AttributeRunFailure> {
  const cell = yield* readCell(input.entityId, input.attributeId)
  return yield* withRun(
    input.runId,
    {
      task: `${ATTRIBUTE_RUN_TASK} · ${cell.def.name}`,
      entityId: cell.record.id,
      startedBy: { type: 'user', id: input.userId },
    },
    (run) => attributeRunInRun(input, cell, run),
    attributeRunMessage,
  )
})

/**
 * The cell inside its run: one lane call, so one step — written once the
 * answer is read, citing the value suggestion it produced (or nothing, when
 * the model found no answer; the call was made and paid for either way).
 */
const attributeRunInRun = Effect.fn('attributeRun.inRun')(function* (
  input: AttributeRunInput,
  cell: Cell,
  run: RunScope,
): Effect.fn.Return<AttributeRunResult, AttributeRunFailure> {
  const { def, ai, record } = cell
  // Checked again here: two presses can race past the button's check.
  if (yield* openFor(record.id, def.slug))
    return yield* new AttributeRunRefused({
      message: `${def.name} already has a proposal waiting in the inbox`,
    })

  const context = yield* recordContextProgram({
    entityId: record.id,
    user: { id: input.userId },
    asOf: input.asOf ?? new Date().toISOString(),
    budgetChars: ATTRIBUTE_RUN_CONTEXT_CHARS,
  }).pipe(Effect.mapError((cause) => new AttributeRunQueryFailed({ cause })))
  const items: Array<ContextItem> = context.items.map((i) => ({
    ref: i.ref,
    kind: i.kind,
    text: i.text,
    entityIds: [record.id],
    at: i.at,
  }))
  const contextRefs = context.items.map((i) => i.ref)

  const task = taskFor(cell)
  const sensitivity = yield* sensitivityFor(record.id)
  const runId = yield* run.id
  const answered = yield* completeProgram(ai.lane, items, outputSchema(cell), {
    caller: { type: 'user', id: input.userId },
    sensitivity: sensitivity.sensitivity,
    ...(sensitivity.sensitivity === 'sensitive'
      ? { via: sensitivity.via }
      : {}),
    budgetChars: ATTRIBUTE_RUN_CONTEXT_CHARS + task.length + 2,
    task,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.jobRunId === undefined ? {} : { jobRunId: input.jobRunId }),
    runId,
  })
  const settle = (result: AttributeRunResult) => {
    const first = result.suggestions.at(0)
    return run
      .step(
        callStep(
          ai.lane,
          contextRefs,
          answered,
          first === undefined ? null : suggestionOutputRef(first.id),
          input.jobRunId,
        ),
      )
      .pipe(Effect.as(result))
  }

  const raw = z
    .record(z.string(), z.unknown())
    .safeParse(
      answered.output.kind === 'object' ? answered.output.object : undefined,
    )
  if (!raw.success)
    return yield* settle({
      suggestions: [],
      proposedOptions: [],
      dropped: [],
      skipped: `The model answered in no shape ${def.name} can be read from`,
    })
  const answer = answerSchema.safeParse(raw.data)
  const reason = answer.success ? (answer.data.reason?.trim() ?? '') : ''
  const dropped: Array<string> = []

  // The field, read leniently: an envelope the model mangled is one line
  // in the result, never a thrown run.
  let value: unknown = undefined
  let fieldRefs: Array<string> = []
  let confidence = 0
  if (def.slug in raw.data) {
    const field = fieldSchema.safeParse(raw.data[def.slug])
    if (!field.success)
      dropped.push(
        `the answer for ${def.name} was not {value, refs, confidence}`,
      )
    else {
      value = field.data.value
      confidence = field.data.confidence
      const known = new Set(contextRefs)
      const cited = field.data.refs ?? []
      fieldRefs = cited.filter((r) => known.has(r))
      if (fieldRefs.length < cited.length)
        dropped.push(
          `${String(cited.length - fieldRefs.length)} cited ref${cited.length - fieldRefs.length === 1 ? '' : 's'} not in the context`,
        )
    }
  }

  // Classify: the vocabulary check, and the options the model wanted.
  let wanted: Array<string> = []
  if (ai.mode === 'classify') {
    const split = splitClassifyValue(def, value)
    value = split.value
    dropped.push(...split.dropped)
    wanted = split.wanted
    const extra = answer.success ? answer.data.newOption?.trim() : undefined
    if (extra !== undefined && extra !== '') {
      const check = splitClassifyValue({ ...def, type: 'select' }, extra)
      // A "new" option that is already an option adds nothing.
      wanted.push(...check.wanted)
    }
  }
  if (value === '' || value === null) value = undefined

  const proposedOptions = yield* keepWanted(cell, wanted, dropped)

  const droppedLine =
    dropped.length === 0 ? null : `Left out: ${dropped.join('; ')}.`
  const refs = fieldRefs.length > 0 ? fieldRefs : contextRefs
  const suggestions: Array<Suggestion> = []
  const proposedBy = { type: 'user', id: input.userId } as const

  if (value !== undefined) {
    const envelope = { value, refs: fieldRefs, confidence }
    const checked = validateProposal([def], { [def.slug]: envelope })
    const payload = jsonValue.safeParse({ [def.slug]: envelope })
    if (!checked.ok || !payload.success)
      dropped.push(
        checked.ok
          ? `the answer for ${def.name} is not JSON`
          : checked.issues.map((i) => i.message).join('; '),
      )
    else
      suggestions.push(
        yield* proposeProgram({
          entityId: record.id,
          kind: 'attribute_patch',
          payload: payload.data,
          rationale: [
            `${def.name} (${AI_MODE_LABEL[ai.mode]}) for ${record.name}, read from the record's context.`,
            reason === '' ? null : reason,
            droppedLine,
            `Accepting writes ${def.name}; nothing else runs.`,
          ]
            .filter((l) => l !== null)
            .join('\n'),
          refs,
          runId,
          proposedBy,
        }),
      )
  }

  for (const label of proposedOptions)
    suggestions.push(
      yield* proposeProgram({
        entityId: record.id,
        kind: 'attribute_patch',
        payload: {},
        rationale: [
          optionProposalLine({ slug: def.slug, name: def.name, label }),
          `${def.name} has no option "${label}"; classifying ${record.name}, the model wanted one.`,
          reason === '' ? null : reason,
          'Add the option from this card to put it in the registry, then run the cell again. Accepting or rejecting alone closes this proposal and changes no attribute.',
        ]
          .filter((l) => l !== null)
          .join('\n'),
        refs,
        runId,
        proposedBy,
      }),
    )

  if (suggestions.length === 0)
    return yield* settle({
      suggestions,
      proposedOptions,
      dropped,
      skipped: [
        `The model found no answer for ${def.name}`,
        dropped.length === 0 ? null : droppedLine,
      ]
        .filter((l) => l !== null)
        .join('. '),
    })
  return yield* settle({ suggestions, proposedOptions, dropped, skipped: null })
})

/**
 * The wanted labels that become registry proposals: trimmed, deduplicated,
 * no longer than an option label may be, and never one the person already
 * rejected for this cell — a rejection is remembered (D41).
 */
const keepWanted = Effect.fn('attributeRun.keepWanted')(function* (
  cell: Cell,
  wanted: ReadonlyArray<string>,
  dropped: Array<string>,
): Effect.fn.Return<Array<string>, AttributeRunQueryFailed> {
  if (wanted.length === 0) return []
  const rejected = new Set(
    (yield* patchRows([cell.record.id], 'rejected')).flatMap((r) =>
      readOptionProposals(r.rationale)
        .filter((p) => p.slug === cell.def.slug)
        .map((p) => p.label.toLowerCase()),
    ),
  )
  const out: Array<string> = []
  for (const label of wanted) {
    const lower = label.toLowerCase()
    if (out.some((l) => l.toLowerCase() === lower)) continue
    if (label.length > OPTION_LABEL_MAX) {
      dropped.push(`"${label.slice(0, 24)}…" is too long for an option`)
      continue
    }
    if (rejected.has(lower)) {
      dropped.push(`"${label}" was proposed as an option before and rejected`)
      continue
    }
    out.push(label)
  }
  return out
})

// ---------- the press ----------

export type AttributeRunEnqueued =
  | { status: 'queued' }
  | { status: 'already-running' }
  | { status: 'already-proposed' }
  | { status: 'queue-unavailable' }

export type AttributeRunRefusal = { status: 'refused'; message: string }

export const cellKey = (entityId: string, attributeId: string) =>
  `${entityId}:${attributeId}`

/**
 * Press a cell's trigger: the cell read, an open proposal refused, the
 * lane's policy checked against the record's sensitivity, then one job keyed
 * on the cell. The queue is `exclusive`, so pg-boss refuses a second send
 * while one is queued or active.
 */
export const enqueueAttributeRunProgram = Effect.fn('enqueueAttributeRun')(
  function* (
    entityId: string,
    attributeId: string,
    userId: string,
  ): Effect.fn.Return<
    AttributeRunEnqueued,
    | AttributeRunRefused
    | AttributeRunQueryFailed
    | SensitivityReadFailed
    | SensitivityEntityNotFound
    | LaneNotRouted
    | RouteReadFailed
    | SensitiveRouteRefused
  > {
    const cell = yield* readCell(entityId, attributeId)
    if (yield* openFor(cell.record.id, cell.def.slug))
      return { status: 'already-proposed' }
    const sensitivity = yield* sensitivityFor(cell.record.id)
    yield* laneTargetProgram(cell.ai.lane, {
      sensitivity: sensitivity.sensitivity,
      ...(sensitivity.sensitivity === 'sensitive'
        ? { via: sensitivity.via }
        : {}),
    })
    const key = cellKey(cell.record.id, cell.def.id)
    const jobId = yield* query(() =>
      enqueue(
        QUEUES.attributeRun,
        { entityId: cell.record.id, attributeId: cell.def.id, userId },
        { singletonKey: key },
      ),
    )
    if (jobId !== null) return { status: 'queued' }
    const jobs = yield* query(() => jobsByKey(QUEUES.attributeRun, key))
    return jobs !== null && jobs.some(inFlight)
      ? { status: 'already-running' }
      : { status: 'queue-unavailable' }
  },
)

/** The press as the server fn runs it: every refusal becomes a sentence. */
export const pressAttributeRunProgram = Effect.fn('pressAttributeRun')(
  function* (
    entityId: string,
    attributeId: string,
    userId: string,
  ): Effect.fn.Return<AttributeRunEnqueued | AttributeRunRefusal> {
    return yield* enqueueAttributeRunProgram(
      entityId,
      attributeId,
      userId,
    ).pipe(
      Effect.catch((failure) => {
        const refused: AttributeRunRefusal = {
          status: 'refused',
          message: attributeRunMessage(failure),
        }
        return Effect.succeed(refused)
      }),
    )
  },
)

// ---------- status + the cells' proposed state ----------

const inFlight = (j: QueuedJob): boolean =>
  j.state === 'created' || j.state === 'retry' || j.state === 'active'

export type AttributeRunStatus =
  | { state: 'idle' }
  | { state: 'running' }
  /** `proposed`: the suggestions this run wrote — zero when it found none. */
  | { state: 'done'; at: string; proposed: number }
  | { state: 'failed'; message: string; at: string }

function reasonOf(output: object | null): string | null {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/** The latest job for a cell, as the trigger reads it. Pure over its inputs. */
export function attributeRunStatusOf(
  jobs: ReadonlyArray<QueuedJob>,
  proposedSince: (since: Date) => number,
): AttributeRunStatus {
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
    message: reasonOf(latest.output) ?? 'The cell could not be run',
    at,
  }
}

export const attributeRunStatusProgram = Effect.fn('attributeRunStatus')(
  function* (
    entityId: string,
    attributeId: string,
  ): Effect.fn.Return<AttributeRunStatus, AttributeRunQueryFailed> {
    const jobs = yield* query(() =>
      jobsByKey(QUEUES.attributeRun, cellKey(entityId, attributeId)),
    )
    if (jobs === null) return { state: 'idle' }
    const registry = yield* query(() => registryFor(db, entityId))
    const slug = registry.find((d) => d.id === attributeId)?.slug
    const rows = yield* query(() =>
      db
        .select({
          payload: suggestion.payload,
          rationale: suggestion.rationale,
          createdAt: suggestion.createdAt,
        })
        .from(suggestion)
        .where(
          and(
            eq(suggestion.entityId, entityId),
            eq(suggestion.kind, 'attribute_patch'),
          ),
        ),
    )
    const mine =
      slug === undefined ? [] : rows.filter((r) => suggestionNames(r, slug))
    return attributeRunStatusOf(
      jobs,
      (since) => mine.filter((m) => m.createdAt >= since).length,
    )
  },
)

export type OpenCellProposal = { entityId: string; slug: string }

/**
 * Every (record, attribute slug) with an open proposal, for the records a
 * surface is showing — one read for a whole table page. The trigger turns
 * into "proposed" on each of them.
 */
export const openCellProposalsProgram = Effect.fn('openCellProposals')(
  function* (
    entityIds: ReadonlyArray<string>,
  ): Effect.fn.Return<Array<OpenCellProposal>, AttributeRunQueryFailed> {
    const rows = yield* patchRows(entityIds, 'open')
    const seen = new Set<string>()
    const out: Array<OpenCellProposal> = []
    for (const r of rows) {
      const slugs = [
        ...Object.keys(jsonRecord(r.payload)),
        ...readOptionProposals(r.rationale).map((p) => p.slug),
      ]
      for (const slug of slugs) {
        const key = `${r.entityId}:${slug}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ entityId: r.entityId, slug })
      }
    }
    return out
  },
)

// ---------- the registry proposal, decided ----------

export type OptionAdded = { attribute: string; label: string; added: boolean }

/**
 * "Add option" on a registry proposal's card: the option goes into the
 * attribute through its existing option-list edit (`updateAttributeProgram`
 * — options can be added, never removed), then the proposal closes as
 * accepted by the person who added it, through `acceptProgram`. Its patch
 * is empty, so the accept writes no value: the next run of the cell is what
 * may propose the new option as one. An option the attribute already has
 * (added by hand since) is not added twice; the proposal still closes.
 */
export const addProposedOptionProgram = Effect.fn('addProposedOption')(
  function* (
    suggestionId: string,
    label: string,
    actorId: string,
  ): Effect.fn.Return<OptionAdded, AttributeRunRefused> {
    const refuse = (message: string) => new AttributeRunRefused({ message })
    const row = yield* query(() =>
      db
        .select()
        .from(suggestion)
        .where(eq(suggestion.id, suggestionId))
        .then((rows) => rows.at(0)),
    ).pipe(Effect.mapError(() => refuse('Could not read the proposal')))
    if (!row) return yield* refuse('That proposal no longer exists')
    if (row.status !== 'open')
      return yield* refuse(`This proposal was already ${row.status}`)
    const proposal = readOptionProposals(row.rationale).find(
      (p) => p.label === label,
    )
    if (row.kind !== 'attribute_patch' || proposal === undefined)
      return yield* refuse('This suggestion proposes no such option')
    const registry = yield* Effect.tryPromise({
      try: () => registryFor(db, row.entityId),
      catch: () => refuse('This record has no attributes'),
    })
    const def = registry.find((d) => d.slug === proposal.slug)
    if (
      !def ||
      def.archived ||
      !['select', 'multi_select', 'status'].includes(def.type)
    )
      return yield* refuse(`${proposal.name} no longer takes options`)
    const current = def.options.options ?? []
    const held = current.some(
      (o) => o.label.toLowerCase() === label.toLowerCase(),
    )
    if (!held)
      yield* updateAttributeProgram({
        id: def.id,
        options: [
          ...current.map((o) => ({
            id: o.id,
            label: o.label,
            group: o.group,
            color: o.color,
            archived: o.archived,
          })),
          { label },
        ],
      }).pipe(
        Effect.mapError((failure) =>
          refuse(
            'message' in failure && typeof failure.message === 'string'
              ? failure.message
              : `Could not add the option to ${def.name}`,
          ),
        ),
      )
    yield* acceptProgram(row.id, { type: 'user', id: actorId }).pipe(
      Effect.mapError((failure) => refuse(suggestionMessage(failure))),
    )
    return { attribute: def.name, label, added: !held }
  },
)
