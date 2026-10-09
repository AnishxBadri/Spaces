import { Context, Effect, Layer, Predicate, Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { workspace } from '@spaces/db/schema'
import { Ai, JobPermanent, JobRetryable } from '@spaces/sdk'
import type { AiItem, AiLane, JobError, Trigger } from '@spaces/sdk'
import { resolveSensitivity, workspaceDefaultOf } from '../../ai/sensitivity'
import type { ResolvedSensitivity } from '../../ai/sensitivity'
import type { JsonSchema } from '../../ai/schema'
import type { ContextItem } from '../../context/types'
import { sensitivityFor } from '../ai/sensitivity-for'
import type { BoundIntegration } from './binding'

/**
 * AiLive: the `Ai` port over core's `complete()`, bound to one integration
 * and one job.
 *
 * - **Sensitivity is core's.** It is resolved live from the entity the
 *   invocation runs on (`sensitivityFor`), or the workspace default when the
 *   job has none. The plugin hands over a lane, items and a schema; nothing
 *   else it attaches is read.
 * - **The subject is bound by the host**, per invocation, through
 *   `AiBinder.bind` — a closure, so no service a plugin provides around its
 *   call can change it.
 * - **A `schedule` job may classify and nothing else**, refused here before
 *   any model is called.
 * - `ModelCall` is `complete()`: the cap check, the sensitive-to-cloud
 *   refusal and the `ai_usage` row with caller `{ type: 'integration' }`.
 */

/** The model call AiLive makes: core's `complete()`, provided by the host. */
export type ModelCallInput = {
  readonly lane: AiLane
  readonly items: ReadonlyArray<ContextItem>
  readonly schema: JsonSchema | undefined
  readonly task: string
  readonly budgetChars: number
  readonly caller: { readonly type: 'integration'; readonly id: string }
  readonly sensitivity: ResolvedSensitivity
}

export type ModelCallOutput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'object'; readonly object: unknown }

/** `complete()` refused or failed: its tag, its sentence, and whether a retry could help. */
export class ModelCallRefused extends Schema.TaggedError<ModelCallRefused>()(
  'ModelCallRefused',
  { tag: Schema.String, message: Schema.String, retryable: Schema.Boolean },
) {}

export class ModelCall extends Context.Service<
  ModelCall,
  {
    readonly complete: (
      input: ModelCallInput,
    ) => Effect.Effect<ModelCallOutput, ModelCallRefused>
  }
>()('spaces/core/writes/ports/ModelCall') {}

/** The host's handle on a built AiLive: an `Ai` bound to one invocation's subject. */
export class AiBinder extends Context.Service<
  AiBinder,
  { readonly bind: (entityId: string | null) => Ai['Service'] }
>()('spaces/core/writes/ports/AiBinder') {}

const ALL_LANES: ReadonlyArray<AiLane> = ['extract', 'classify', 'synthesize']

/** The lanes a job of this trigger may call: a `schedule` job (a poller) classifies only. */
export const aiLanesFor = (trigger: Trigger): ReadonlyArray<AiLane> =>
  trigger === 'schedule' ? ['classify'] : ALL_LANES

/** What the model is asked to do with the items, per lane. */
const TASK: { readonly [L in AiLane]: string } = {
  extract:
    'Extract what the output schema asks for from the context above. Use only what the context states.',
  classify:
    'Classify the context above into the output schema. Choose only from the options it allows.',
  synthesize:
    'Write a short brief from the context above. Cite each claim by the [ref] it came from.',
}

/** The rendered prompt's ceiling per lane, task included. */
const BUDGET_CHARS: { readonly [L in AiLane]: number } = {
  extract: 48_000,
  classify: 6_000,
  synthesize: 24_000,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const JSON_TYPES = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
] as const
type JsonType = (typeof JSON_TYPES)[number]
const isJsonType = (value: unknown): value is JsonType =>
  JSON_TYPES.some((t) => t === value)

const NUMERIC_KEYS = [
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
] as const
const TEXT_KEYS = ['title', 'description', 'format', 'pattern'] as const

/**
 * A plugin's zod schema as the JSON Schema `complete()` hands the provider:
 * the subset core speaks, read off `z.toJSONSchema`. A keyword outside it is
 * dropped, which only loosens what the provider is told — the answer is
 * still parsed against the plugin's own schema.
 */
export const toJsonSchema = (value: unknown): JsonSchema => {
  const out: JsonSchema = {}
  if (!Predicate.isObject(value)) return out
  const type = Reflect.get(value, 'type')
  if (isJsonType(type)) out.type = type
  for (const key of TEXT_KEYS) {
    const v = Reflect.get(value, key)
    if (Predicate.isString(v)) out[key] = v
  }
  for (const key of NUMERIC_KEYS) {
    const v = Reflect.get(value, key)
    if (Predicate.isNumber(v)) out[key] = v
  }
  const uniqueItems = Reflect.get(value, 'uniqueItems')
  if (Predicate.isBoolean(uniqueItems)) out.uniqueItems = uniqueItems
  const additional = Reflect.get(value, 'additionalProperties')
  if (Predicate.isBoolean(additional)) out.additionalProperties = additional
  const values = Reflect.get(value, 'enum')
  if (Array.isArray(values)) out.enum = values.filter(Predicate.isString)
  const required = Reflect.get(value, 'required')
  if (Array.isArray(required))
    out.required = required.filter(Predicate.isString)
  const items = Reflect.get(value, 'items')
  if (Predicate.isObject(items)) out.items = toJsonSchema(items)
  const properties = Reflect.get(value, 'properties')
  if (Predicate.isObject(properties))
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([k, v]) => [k, toJsonSchema(v)]),
    )
  return out
}

/** Only the ref and the text of each item: whatever else a plugin attaches is dropped. */
const contextItems = (
  items: ReadonlyArray<AiItem>,
): ReadonlyArray<ContextItem> =>
  items.map((item) => ({
    ref: String(item.ref),
    kind: 'event',
    text: String(item.text),
    entityIds: [],
    at: null,
  }))

/** The workspace default alone: the sensitivity of a job with no entity. */
const workspaceSensitivity = Effect.tryPromise({
  try: () =>
    db
      .select({
        value: sql<
          string | null
        >`${workspace.settings} ->> 'sensitivity_default'`,
      })
      .from(workspace)
      .limit(1),
  catch: (cause) =>
    new JobRetryable({
      reason: `Ai.complete could not read the workspace sensitivity: ${messageOf(cause)}`,
    }),
}).pipe(
  Effect.map((rows): ResolvedSensitivity =>
    resolveSensitivity({
      own: false,
      spaces: [],
      binding: null,
      workspaceDefault: workspaceDefaultOf(rows.at(0)?.value),
    }),
  ),
)

const subjectSensitivity = (
  entityId: string | null,
): Effect.Effect<ResolvedSensitivity, JobError> => {
  if (entityId === null) return workspaceSensitivity
  if (!UUID.test(entityId))
    return Effect.fail(
      new JobPermanent({ reason: `Ai.complete: no record ${entityId}` }),
    )
  return sensitivityFor(entityId).pipe(
    Effect.map((read): ResolvedSensitivity =>
      read.sensitivity === 'sensitive'
        ? { sensitivity: 'sensitive', via: read.via }
        : { sensitivity: 'normal' },
    ),
    Effect.mapError((error) =>
      error._tag === 'SensitivityEntityNotFound'
        ? new JobPermanent({ reason: `Ai.complete: no record ${entityId}` })
        : new JobRetryable({
            reason: `Ai.complete could not resolve sensitivity: ${messageOf(error.cause)}`,
          }),
    ),
  )
}

const refusal = (error: ModelCallRefused): JobError =>
  error.retryable
    ? new JobRetryable({
        reason: `Ai.complete failed: ${error.tag}: ${error.message}`,
      })
    : new JobPermanent({ reason: `${error.tag}: ${error.message}` })

/**
 * The Ai port for one (integration, job). The Layer's own `Ai` has no
 * subject; the host replaces it per invocation with `AiBinder.bind(entityId)`.
 */
export const AiLive = (
  row: Pick<BoundIntegration, 'id'>,
  options: { readonly trigger: Trigger },
): Layer.Layer<Ai | AiBinder, never, ModelCall> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const model = yield* ModelCall
      const lanes = aiLanesFor(options.trigger)
      const caller = { type: 'integration', id: row.id } as const

      const call = (
        entityId: string | null,
        lane: AiLane,
        items: ReadonlyArray<AiItem>,
        schema: z.ZodType | undefined,
      ): Effect.Effect<ModelCallOutput, JobError> =>
        Effect.gen(function* () {
          if (!lanes.includes(lane)) {
            return yield* new JobPermanent({
              reason: `Ai.complete: a ${options.trigger} job may call the ${lanes.join(', ')} lane only, not ${lane}`,
            })
          }
          const sensitivity = yield* subjectSensitivity(entityId)
          return yield* model
            .complete({
              lane,
              items: contextItems(items),
              schema:
                schema === undefined
                  ? undefined
                  : toJsonSchema(z.toJSONSchema(schema)),
              task: TASK[lane],
              budgetChars: BUDGET_CHARS[lane],
              caller,
              sensitivity,
            })
            .pipe(Effect.mapError(refusal))
        })

      const bind = (entityId: string | null): Ai['Service'] => {
        function complete(
          lane: AiLane,
          items: ReadonlyArray<AiItem>,
        ): Effect.Effect<string, JobError>
        function complete<TResult>(
          lane: AiLane,
          items: ReadonlyArray<AiItem>,
          schema: z.ZodType<TResult>,
        ): Effect.Effect<TResult, JobError>
        function complete<TResult>(
          lane: AiLane,
          items: ReadonlyArray<AiItem>,
          schema?: z.ZodType<TResult>,
        ): Effect.Effect<string | TResult, JobError> {
          return call(entityId, lane, items, schema).pipe(
            Effect.flatMap(
              (output): Effect.Effect<string | TResult, JobError> => {
                if (schema === undefined)
                  return output.kind === 'text'
                    ? Effect.succeed(output.text)
                    : Effect.fail(
                        new JobPermanent({
                          reason: `Ai.complete: the ${lane} lane answered with an object where text was asked for`,
                        }),
                      )
                const parsed = schema.safeParse(
                  output.kind === 'object' ? output.object : output.text,
                )
                return parsed.success
                  ? Effect.succeed(parsed.data)
                  : Effect.fail(
                      new JobPermanent({
                        reason: `Ai.complete: the ${lane} lane's answer does not match the schema`,
                      }),
                    )
              },
            ),
          )
        }
        return Ai.of({ complete })
      }

      return Context.make(Ai, bind(null)).pipe(
        Context.add(AiBinder, AiBinder.of({ bind })),
      )
    }),
  )
