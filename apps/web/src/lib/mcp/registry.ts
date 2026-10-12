import { Effect } from 'effect'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { parseRef } from '@spaces/core/context/ref'
import {
  DEFAULT_BUDGET_CHARS,
  recordContextProgram,
} from '@spaces/core/writes/context/record'
import { jsonValue } from '@spaces/core/json'
import { SimilarLaneLive } from '#/lib/ai/similar'
import {
  McpToolRefused,
  getRecordProgram,
  resolveEntityRefProgram,
} from './tools'
import { proposeSuggestionProgram } from './tools-propose'
import {
  QUERY_RECORDS_MAX,
  holdingDetailProgram,
  holdingDetailShape,
  listRegistryProgram,
  portfolioSummaryProgram,
  portfolioSummaryShape,
  queryRecordsProgram,
  queryRecordsShape,
  searchRecordsProgram,
} from './tools-read'

/**
 * The one tool table: every tool the external MCP server registers and Ask
 * calls in process. (D70, spec-ai-substrate §5–6)
 * - Both clients go through `toolRegistry.call`, so one canRead, one
 *   sensitivity rule and one set of refusals apply to both.
 * - A tool answers its value plus what Ask's gate and call strip read: the
 *   entities the value reveals (`touches`), the context refs it carries, and
 *   a count.
 */

/** Who is calling a tool: whose canRead applies, and who a proposal names. */
export type ToolCaller = {
  userId: string
  proposer:
    { kind: 'token'; tokenId: string } | { kind: 'ask'; runId: string | null }
}

/** A tool's answer, with what Ask reads off it. */
export type ToolAnswer = {
  value: unknown
  /** Entity ids the value reveals: Ask's sensitivity gate and citation check. */
  touches: ReadonlyArray<string>
  /** Context refs the value carries, citable as written. */
  refs: ReadonlyArray<string>
  /** How many things it found; null for a tool that counts nothing. */
  found: number | null
  /** What was asked, in a few words, for the call strip. */
  input: string
}

/** A refusal or failure, carrying the sentence the caller is shown. */
export type ToolFailure = Error & { readonly _tag: string }

type ToolSpec<TShape extends z.ZodRawShape, TOut> = {
  name: string
  title: string
  description: string
  inputSchema: TShape
  annotations: ToolAnnotations
  run: (
    caller: ToolCaller,
    input: z.infer<z.ZodObject<TShape>>,
  ) => Effect.Effect<TOut, ToolFailure>
  touches: (out: TOut) => ReadonlyArray<string>
  refs?: (out: TOut) => ReadonlyArray<string>
  found?: (out: TOut) => number | null
  input: (input: z.infer<z.ZodObject<TShape>>) => string
}

export type RegisteredTool = {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: z.ZodRawShape
  readonly annotations: ToolAnnotations
  readonly invoke: (
    caller: ToolCaller,
    raw: unknown,
  ) => Effect.Effect<ToolAnswer, ToolFailure>
}

/** Close a tool's types over its own schema; the table holds the erased shape. */
function defineTool<TShape extends z.ZodRawShape, TOut>(
  spec: ToolSpec<TShape, TOut>,
): RegisteredTool {
  const schema = z.object(spec.inputSchema)
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    invoke: (caller, raw) => {
      const parsed = schema.safeParse(raw)
      if (!parsed.success)
        return Effect.fail(
          new McpToolRefused({
            message: `Bad input for ${spec.name}: ${parsed.error.issues
              .map((i) => `${i.path.join('.') || 'input'} ${i.message}`)
              .join('; ')}`,
          }),
        )
      return spec.run(caller, parsed.data).pipe(
        Effect.map((out): ToolAnswer => ({
          value: out,
          touches: [...new Set(spec.touches(out))],
          refs: spec.refs?.(out) ?? [],
          found: spec.found?.(out) ?? null,
          input: spec.input(parsed.data),
        })),
      )
    },
  }
}

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }

/** The entity a context ref belongs to, when it names one. */
export function entityOfRef(r: string): string | null {
  const p = parseRef(r)
  if (p === null) return null
  return 'entityId' in p ? p.entityId : null
}

const getContext = defineTool({
  name: 'get_context',
  title: 'Record context',
  description:
    'What Spaces knows about one record — its attributes, history, notes, memos, documents, spaces and tasks — ranked and trimmed to a character budget, each item with a citation. Exactly what the record page’s Context section shows the same person. Pass a record id, or a record’s exact name.',
  inputSchema: {
    entity: z
      .string()
      .min(1)
      .describe('Record id (uuid), or the record’s exact name'),
    task: z
      .string()
      .optional()
      .describe(
        'What you are trying to do; ranks matching document passages first',
      ),
    budget: z
      .number()
      .int()
      .min(500)
      .max(100_000)
      .optional()
      .describe(`Character budget; default ${DEFAULT_BUDGET_CHARS}`),
  },
  annotations: readOnly,
  run: (caller, { entity, task, budget }) =>
    Effect.gen(function* () {
      const me = { id: caller.userId }
      const entityId = yield* resolveEntityRefProgram(me, entity)
      return yield* recordContextProgram({
        entityId,
        user: me,
        asOf: new Date().toISOString(),
        budgetChars: budget ?? DEFAULT_BUDGET_CHARS,
        similar: false,
        taskText: task?.trim() ? task.trim() : undefined,
      }).pipe(Effect.provide(SimilarLaneLive))
    }),
  touches: (out) => [
    out.seed.id,
    ...out.items.flatMap((i) => {
      const id = entityOfRef(i.ref)
      return id === null ? [] : [id]
    }),
  ],
  refs: (out) => out.items.map((i) => i.ref),
  found: (out) => out.items.length,
  input: ({ entity }) => entity,
})

const getRecord = defineTool({
  name: 'get_record',
  title: 'Record',
  description:
    'One record, shaped by its object’s attribute registry: every attribute with its stored value and a readable rendering (the inverse half of a relationship marked derived, its value read from the other side), then its links in both directions and the spaces it is tagged into.',
  inputSchema: { id: z.string().uuid().describe('Record id (uuid)') },
  annotations: readOnly,
  run: (caller, { id }) => getRecordProgram({ id: caller.userId }, id),
  touches: (out) => [out.id],
  found: () => 1,
  input: ({ id }) => id,
})

// The one write verb — a proposal into Review through `proposeProgram`. No
// accept, write, delete or merge tool is registered, ever (spec §6).
const proposeSuggestion = defineTool({
  name: 'propose_suggestion',
  title: 'Propose a suggestion',
  description:
    'Propose attribute values for one record. Nothing is written: the proposal lands in Review in Spaces, labelled with this token, and a person accepts or rejects it. The patch is keyed by attribute slug (see get_record), each field wrapped as {value, refs, confidence}; it is validated against the record’s live attribute registry and refused field by field.',
  inputSchema: {
    entity: z
      .string()
      .min(1)
      .describe('Record id (uuid), or the record’s exact name'),
    patch: z
      .record(z.string(), jsonValue)
      .describe(
        '{[attribute slug]: {value, refs: string[], confidence: 0..1}}',
      ),
    rationale: z
      .string()
      .min(1)
      .describe('Why these values — what the reviewer reads first'),
    refs: z
      .array(z.string())
      .optional()
      .describe(
        'Citation refs for the whole proposal; default: the union of each field’s refs',
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  run: (caller, { entity, patch, rationale, refs }) =>
    proposeSuggestionProgram(
      caller.proposer.kind === 'token'
        ? { id: caller.userId, tokenId: caller.proposer.tokenId }
        : { id: caller.userId, runId: caller.proposer.runId },
      { entity, patch, rationale, ...(refs === undefined ? {} : { refs }) },
    ),
  touches: (out) => [out.entityId],
  found: () => 1,
  input: ({ entity }) => entity,
})

const searchRecords = defineTool({
  name: 'search_records',
  title: 'Search records',
  description:
    'Search Spaces the way its Cmd-K box does — record names and aliases (typo-tolerant), note bodies, document text, tasks, and meaning when an embedding model is configured — fused into one ranked list of at most 20 hits. Each hit carries its id (pass it to get_record or get_context), kind, name, object, and a snippet marked «like this». Pass `object` to keep only one object’s records.',
  inputSchema: {
    query: z.string().min(1).max(200).describe('What to look for'),
    object: z
      .string()
      .min(1)
      .optional()
      .describe(
        'An object’s slug, singular or plural name (see list_registry); only its records are returned',
      ),
  },
  annotations: readOnly,
  run: (caller, { query, object }) =>
    searchRecordsProgram({ id: caller.userId }, { query, object }),
  touches: (hits) =>
    hits.flatMap((h) => [h.id, ...(h.parent === null ? [] : [h.parent.id])]),
  found: (hits) => hits.length,
  input: ({ query, object }) =>
    object === undefined ? `“${query}”` : `“${query}” in ${object}`,
})

// D70: structured questions over the views compiler, never generated.
const queryRecords = defineTool({
  name: 'query_records',
  title: 'Query records',
  description: `Records of one object that meet conditions, sorted, with the total that match — computed in the database by the same compiler as the list pages’ filters and view counts, never estimated and never summarised. Conditions are keyed by attribute slug (see list_registry) with ops is, is_not, contains, empty, not_empty, gt, lt; a bare value means "is". A space condition {id, includeDescendants} keeps records filed in that space and, by default, any space below it. The interaction columns last_interaction, first_email, last_email and next_meeting filter as days and sort by time. Each row carries its id (pass it to get_record or get_context), name, stored values and sort value; at most ${QUERY_RECORDS_MAX} rows, and total counts them all. An unknown attribute or space is refused by name.`,
  inputSchema: queryRecordsShape,
  annotations: readOnly,
  run: (caller, input) => queryRecordsProgram({ id: caller.userId }, input),
  touches: (out) => out.rows.map((r) => r.id),
  found: (out) => out.total,
  input: ({ object }) => object,
})

// D70: money over the pure portfolio libraries, never generated.
const portfolioSummary = defineTool({
  name: 'portfolio_summary',
  title: 'Portfolio summary',
  description:
    'The portfolio as the Portfolio page reads it, computed from the event ledger rather than estimated: per holding and for the whole book, invested (cost basis), value (what is still held — the latest mark, or cost when never marked), distributions (cash returned), TVPI, DPI and gross IRR (annualized; 0.15 is 15%). Money is plain numbers in the named currency: each holding in its own currency when all its events share one, else base; the total always in base. A holding missing an exchange rate has null figures, names the rates it needs, and is left out of the total. Each holding carries its id for holding_detail.',
  inputSchema: portfolioSummaryShape,
  annotations: readOnly,
  run: (_caller, { asOf }) => portfolioSummaryProgram({ asOf }),
  touches: (out) => out.holdings.map((h) => h.companyId),
  found: (out) => out.holdings.length,
  input: ({ asOf }) => asOf ?? 'today',
})

const holdingDetail = defineTool({
  name: 'holding_detail',
  title: 'Holding detail',
  description:
    'One holding’s figures (as portfolio_summary), ownership, and its ledger — investments, marks and distributions — as it stood on the as-of day: entries dated after it are left out, a voided entry is gone once its void had happened, and correction rows never appear. An entry voided after the as-of day is shown, with reversedAt naming when it was voided. Money is plain numbers with each entry’s currency.',
  inputSchema: holdingDetailShape,
  annotations: readOnly,
  run: (_caller, { holdingId, asOf }) =>
    holdingDetailProgram({ holdingId, asOf }),
  touches: (out) => [out.companyId],
  found: () => 1,
  input: ({ holdingId }) => holdingId,
})

const listRegistry = defineTool({
  name: 'list_registry',
  title: 'Object registry',
  description:
    'The workspace’s object registry: every object (Companies, People, Deals and any custom object), each with its attributes in order — slug, name, description, type, the object a reference points at, and per-type options such as select and status choices. Always current: an object or attribute created a moment ago is listed.',
  inputSchema: {
    object: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Just this object — its slug, singular or plural name; omit for all',
      ),
  },
  annotations: readOnly,
  run: (_caller, { object }) => listRegistryProgram({ object }),
  touches: () => [],
  input: ({ object }) => object ?? 'all objects',
})

export const MCP_TOOLS: ReadonlyArray<RegisteredTool> = [
  getContext,
  getRecord,
  proposeSuggestion,
  searchRecords,
  queryRecords,
  portfolioSummary,
  holdingDetail,
  listRegistry,
]

/**
 * The door both clients call. A method on an object, so a test can spy on
 * it and see every call either client makes.
 */
export const toolRegistry = {
  tools: MCP_TOOLS,
  call(
    name: string,
    caller: ToolCaller,
    raw: unknown,
  ): Effect.Effect<ToolAnswer, ToolFailure> {
    const tool = MCP_TOOLS.find((t) => t.name === name)
    return tool === undefined
      ? Effect.fail(new McpToolRefused({ message: `No tool ${name}` }))
      : tool.invoke(caller, raw)
  },
}
