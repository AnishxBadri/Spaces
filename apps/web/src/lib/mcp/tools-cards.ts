import { Effect } from 'effect'
import { z } from 'zod'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, objectDef, space } from '@spaces/db/schema'
import type { Json } from '@spaces/core/json'
import { jsonString } from '@spaces/core/json'
import { registryFor } from '@spaces/core/writes/suggestions/propose'
import { liveSpaceSql } from '#/lib/spaces/live'
import { recordPath } from '#/lib/record-path'
import { cardEntry, isCalendarDate } from '#/lib/ask/cards'
import type { AskCardKind } from '#/lib/ask/types'
import {
  McpToolQueryFailed,
  McpToolRefused,
} from '@spaces/core/writes/read/record'
import { proposableEntity } from './tools-propose'
import type { ProposeCaller } from './tools-propose'

/**
 * `propose_card`: an action card checked against the workspace and handed
 * back to the turn, which stores it as an open suggestion when the answer
 * lands. Nothing is written here.
 * - Ask only: an MCP token proposes through `propose_suggestion`.
 * - A card naming what is already so (the stage it is in, a space it is filed
 *   in) is refused, so the model is told rather than the reader.
 */

const CARD_KINDS = [
  'task',
  'move_stage',
  'file_into_space',
  'log_signal',
  'note',
  'draft_email',
  'add_record',
  'save_as_watch',
] as const satisfies ReadonlyArray<AskCardKind>

export const proposeCardShape = {
  kind: z
    .enum(CARD_KINDS)
    .describe(
      'task (create a task on the record), move_stage (a deal to another pipeline stage), file_into_space (file the record in a space)',
    ),
  record: z
    .string()
    .min(1)
    .describe('The record the card acts on: id (uuid) or exact name'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe('task: what to do, as the task will read'),
  due: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .optional()
    .describe('task: due date, YYYY-MM-DD'),
  stage: z
    .string()
    .min(1)
    .optional()
    .describe('move_stage: the stage to move to, by id or label'),
  space: z
    .string()
    .min(1)
    .optional()
    .describe('file_into_space: the space, by id or exact name'),
  refs: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Evidence: refs this turn retrieved — [record:<id>] or a context ref as written. A card without evidence is not shown.',
    ),
  rationale: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('Why, in one sentence, for the reader'),
}

export type ProposeCardInput = z.infer<z.ZodObject<typeof proposeCardShape>>

/** A card as the turn holds it until the answer lands. */
export type CardDraft = {
  kind: AskCardKind
  suggestionKind: 'task' | 'space_tag' | 'attribute_patch'
  payload: Json
  rationale: string
  /** As the model gave them; the turn keeps only those it retrieved. */
  refs: ReadonlyArray<string>
  record: { id: string; name: string; href: string | null }
  summary: string
  /** `move_stage`: the stage the deal held when proposed; null otherwise. */
  from: string | null
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new McpToolQueryFailed({ cause }),
  })

const refuse = (message: string) => new McpToolRefused({ message })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A live space by id or exact name, with its path of names. */
const spaceOf = Effect.fn('spaceOf')(function* (wanted: string) {
  const key = wanted.trim()
  const rows = yield* query(() =>
    db
      .select({ id: space.entityId, name: entity.canonicalName })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        and(
          isNull(entity.mergedIntoId),
          liveSpaceSql,
          UUID.test(key)
            ? eq(space.entityId, key.toLowerCase())
            : sql`lower(${entity.canonicalName}) = lower(${key})`,
        ),
      )
      .limit(3),
  )
  const only = rows.at(0)
  if (!only) return yield* refuse(`No space ${key}`)
  if (rows.length > 1)
    return yield* refuse(
      `Several spaces are named "${key}" — ask again by id: ${rows.map((r) => r.id).join(', ')}`,
    )
  const path = yield* query(() =>
    db.execute<{ path: string | null }>(sql`
      select string_agg(e.canonical_name, ' / ' order by nlevel(a.path)) as path
      from space s
      join space a on a.path @> s.path
      join entity e on e.id = a.entity_id
      where s.entity_id = ${only.id}::uuid
    `),
  )
  return { id: only.id, label: path.rows.at(0)?.path ?? only.name }
})

export const proposeCardProgram = Effect.fn('proposeCardProgram')(function* (
  caller: ProposeCaller,
  input: ProposeCardInput,
): Effect.fn.Return<CardDraft, McpToolRefused | McpToolQueryFailed> {
  if ('tokenId' in caller)
    return yield* refuse(
      'Action cards are Ask’s; propose attribute values with propose_suggestion',
    )
  const entry = cardEntry(input.kind)
  if (!entry.available)
    return yield* refuse(`${entry.label} cards are not available yet`)

  const entityId = yield* proposableEntity(caller, input.record)
  const row = (yield* query(() =>
    db
      .select({
        id: entity.id,
        kind: entity.kind,
        name: entity.canonicalName,
        values: entity.values,
        objectSlug: objectDef.slug,
      })
      .from(entity)
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(eq(entity.id, entityId)),
  )).at(0)
  if (!row) return yield* refuse(`No record ${input.record.trim()}`)
  const record = { id: row.id, name: row.name, href: recordPath(row) }
  const base = {
    kind: input.kind,
    rationale: input.rationale,
    record,
    from: null,
  }
  const refs = [...new Set(input.refs.map((r) => r.trim()))]

  switch (input.kind) {
    case 'task': {
      if (input.title === undefined)
        return yield* refuse('A task card needs a title')
      const due = input.due ?? null
      if (due !== null && !isCalendarDate(due))
        return yield* refuse(`No such date ${due}`)
      return {
        ...base,
        suggestionKind: 'task',
        payload: { title: input.title, due, entity_id: row.id },
        refs,
        summary: due === null ? input.title : `${input.title} · due ${due}`,
      }
    }
    case 'move_stage': {
      if (input.stage === undefined)
        return yield* refuse('A move_stage card needs a stage')
      const registry = yield* query(() => registryFor(db, row.id))
      const def = registry.find((d) => d.slug === 'stage' && !d.archived)
      if (row.kind !== 'deal' || def === undefined)
        return yield* refuse(`${row.name} has no pipeline stage`)
      const wanted = input.stage.trim().toLowerCase()
      const options = (def.options.options ?? []).filter((o) => !o.archived)
      const to = options.find(
        (o) =>
          o.id.toLowerCase() === wanted || o.label.toLowerCase() === wanted,
      )
      if (to === undefined)
        return yield* refuse(
          `No stage ${input.stage} — the stages are ${options.map((o) => o.label).join(', ')}`,
        )
      // Closing a deal is a person's call, with its reason and its holding.
      if (to.group === 'closed')
        return yield* refuse(
          `Moving to ${to.label} closes the deal; a person does that from the deal`,
        )
      const held = jsonString(row.values.stage)
      if (held === to.id)
        return yield* refuse(`${row.name} is already in ${to.label}`)
      const from = options.find((o) => o.id === held)
      return {
        ...base,
        from: held,
        suggestionKind: 'attribute_patch',
        payload: { stage: { value: to.id, refs: [], confidence: 1 } },
        refs,
        summary:
          from === undefined ? `→ ${to.label}` : `${from.label} → ${to.label}`,
      }
    }
    case 'file_into_space': {
      if (input.space === undefined)
        return yield* refuse('A file_into_space card needs a space')
      const target = yield* spaceOf(input.space)
      const filed = (yield* query(() =>
        db
          .select({ id: entitySpace.entityId })
          .from(entitySpace)
          .where(
            and(
              eq(entitySpace.entityId, row.id),
              eq(entitySpace.spaceId, target.id),
            ),
          ),
      )).at(0)
      if (filed !== undefined)
        return yield* refuse(`${row.name} is already filed in ${target.label}`)
      return {
        ...base,
        suggestionKind: 'space_tag',
        payload: { spaceId: target.id, label: target.label },
        refs,
        summary: target.label,
      }
    }
    default:
      return yield* refuse(`${entry.label} cards are not available yet`)
  }
})
