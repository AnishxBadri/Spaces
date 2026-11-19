import { Effect, Result, Schema } from 'effect'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { int, between, uuidString } from '@spaces/core/attributes/registry'
import { parseRef } from '@spaces/core/context/ref'
import {
  DEFAULT_BUDGET_CHARS,
  recordContextProgram,
} from '@spaces/core/writes/context/record'
import { jsonValue } from '@spaces/core/json'
import { plainRecord } from '#/lib/plain-record'
import { SimilarLaneLive } from '#/lib/ai/similar'
import {
  McpToolRefused,
  getRecordProgram,
  resolveEntityRefProgram,
} from '@spaces/core/writes/read/record'
import { proposeSuggestionProgram } from './tools-propose'
import type { ProposeCaller } from './tools-propose'
import {
  proposeCardInput,
  proposeCardJsonSchema,
  proposeCardProgram,
} from './tools-cards'
import type { CardDraft } from './tools-cards'
import {
  QUERY_RECORDS_MAX,
  holdingDetailInput,
  holdingDetailJsonSchema,
  holdingDetailProgram,
  listRegistryProgram,
  portfolioSummaryInput,
  portfolioSummaryJsonSchema,
  portfolioSummaryProgram,
  queryRecordsInput,
  queryRecordsJsonSchema,
  queryRecordsProgram,
  searchRecordsProgram,
} from './tools-read'
import {
  DRAFT_07,
  UUID_PATTERN,
  closedObjects,
  decoderFor,
  modelSchema,
} from './input-schema'
import type { ToolInputSchema } from './input-schema'

/**
 * The one tool table: every tool the external MCP server registers and Ask
 * calls in process.
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
  /**
   * Ask's turn on a non-local route: `get_context` leaves sensitive chunks
   * out (`AssembleOptions.excludeSensitive`).
   */
  excludeSensitive?: boolean
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
  /** The action card a `propose_card` call handed back; null for any other tool. */
  card: CardDraft | null
  /**
   * A proposal tool: what it touches names its target, never what the turn
   * read, so it is no evidence for a card or a citation.
   */
  proposal: boolean
}

/** A refusal or failure, carrying the sentence the caller is shown. */
export type ToolFailure = Error & { readonly _tag: string }

type ToolSpec<TInput, TOut> = {
  name: string
  title: string
  description: string
  /** What decodes a call: the one check either client's input passes. */
  decoder: Schema.Decoder<TInput>
  /** The same input as a client is shown it. */
  inputSchema: ToolInputSchema
  annotations: ToolAnnotations
  run: (caller: ToolCaller, input: TInput) => Effect.Effect<TOut, ToolFailure>
  touches: (out: TOut) => ReadonlyArray<string>
  refs?: (out: TOut) => ReadonlyArray<string>
  found?: (out: TOut) => number | null
  input: (input: TInput) => string
  card?: (out: TOut) => CardDraft
  proposal?: true
  /** What the model is handed; default the whole output. */
  value?: (out: TOut) => unknown
}

export type RegisteredTool = {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: ToolInputSchema
  readonly annotations: ToolAnnotations
  /** The call's input as the tool reads it, or every refusal in one sentence. */
  readonly decode: (raw: unknown) => Result.Result<unknown, string>
  readonly invoke: (
    caller: ToolCaller,
    raw: unknown,
  ) => Effect.Effect<ToolAnswer, ToolFailure>
}

/** Close a tool's types over its own schema; the table holds the erased shape. */
function defineTool<TInput, TOut>(
  spec: ToolSpec<TInput, TOut>,
): RegisteredTool {
  const read = decoderFor(spec.decoder)
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    decode: read,
    invoke: (caller, raw) => {
      const parsed = read(raw)
      if (Result.isFailure(parsed))
        return Effect.fail(
          new McpToolRefused({
            message: `Bad input for ${spec.name}: ${parsed.failure}`,
          }),
        )
      const input = parsed.success
      return spec.run(caller, input).pipe(
        Effect.map((out): ToolAnswer => ({
          value: spec.value?.(out) ?? out,
          touches: [...new Set(spec.touches(out))],
          refs: spec.refs?.(out) ?? [],
          found: spec.found?.(out) ?? null,
          input: spec.input(input),
          card: spec.card?.(out) ?? null,
          proposal: spec.proposal === true,
        })),
      )
    },
  }
}

/** The proposer a write tool names: the API token over MCP, the user in Ask. */
const proposerOf = (caller: ToolCaller): ProposeCaller =>
  caller.proposer.kind === 'token'
    ? { id: caller.userId, tokenId: caller.proposer.tokenId }
    : { id: caller.userId, runId: caller.proposer.runId }

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }

const nonEmpty = Schema.String.check(Schema.isMinLength(1))

const RECORD_REF = 'Record id (uuid), or the record’s exact name'

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
    'What Spaces knows about one record — its attributes, history, notes, memos, documents, the full path of every space it is filed in, the other companies in its leaf space, and tasks — ranked and trimmed to a character budget, each item with a citation. Exactly what the record page’s Context section shows the same person. A space answers as a market: its path, subspace tree with counts, companies by stage, memos and terms. A document answers with its own pages first. Pass an id, or an exact name.',
  decoder: Schema.Struct({
    entity: nonEmpty,
    task: Schema.optional(Schema.String),
    budget: Schema.optional(Schema.Number.check(int, between(500, 100_000))),
  }),
  inputSchema: {
    $schema: DRAFT_07,
    type: 'object',
    properties: {
      entity: { type: 'string', minLength: 1, description: RECORD_REF },
      task: {
        description:
          'What you are trying to do; ranks matching document passages first',
        type: 'string',
      },
      budget: {
        description: `Character budget; default ${String(DEFAULT_BUDGET_CHARS)}`,
        type: 'integer',
        minimum: 500,
        maximum: 100_000,
      },
    },
    required: ['entity'],
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
        excludeSensitive: caller.excludeSensitive === true,
      }).pipe(Effect.provide(SimilarLaneLive))
    }),
  // Everything the context is about — a space's subspaces and members too —
  // so the egress gate reads a sensitive descendant.
  touches: (out) => [
    out.seed.id,
    ...out.reveals,
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
  decoder: Schema.Struct({ id: uuidString }),
  inputSchema: {
    $schema: DRAFT_07,
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        pattern: UUID_PATTERN,
        description: 'Record id (uuid)',
      },
    },
    required: ['id'],
  },
  annotations: readOnly,
  run: (caller, { id }) => getRecordProgram({ id: caller.userId }, id),
  touches: (out) => [out.id],
  found: () => 1,
  input: ({ id }) => id,
})

// The one write verb — a proposal into Review through `proposeProgram`. No
// accept, write, delete or merge tool is registered, ever.
const proposeSuggestion = defineTool({
  name: 'propose_suggestion',
  title: 'Propose a suggestion',
  description:
    'Propose attribute values for one record. Nothing is written: the proposal lands in Review in Spaces, labelled with this token, and a person accepts or rejects it. The patch is keyed by attribute slug (see get_record), each field wrapped as {value, refs, confidence}; it is validated against the record’s live attribute registry and refused field by field.',
  decoder: Schema.Struct({
    entity: nonEmpty,
    patch: plainRecord(jsonValue),
    rationale: nonEmpty,
    refs: Schema.optional(Schema.Array(Schema.String)),
  }),
  inputSchema: {
    $schema: DRAFT_07,
    type: 'object',
    properties: {
      entity: { type: 'string', minLength: 1, description: RECORD_REF },
      patch: {
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { $ref: '#/definitions/__schema0' },
        description:
          '{[attribute slug]: {value, refs: string[], confidence: 0..1}}',
      },
      rationale: {
        type: 'string',
        minLength: 1,
        description: 'Why these values — what the reviewer reads first',
      },
      refs: {
        description:
          'Citation refs for the whole proposal; default: the union of each field’s refs',
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['entity', 'patch', 'rationale'],
    definitions: {
      // Any JSON value, as the patch's decoder reads one.
      __schema0: {
        anyOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'null' },
          { type: 'array', items: { $ref: '#/definitions/__schema0' } },
          {
            type: 'object',
            propertyNames: { type: 'string' },
            additionalProperties: { $ref: '#/definitions/__schema0' },
          },
        ],
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  run: (caller, { entity, patch, rationale, refs }) =>
    proposeSuggestionProgram(proposerOf(caller), {
      entity,
      patch,
      rationale,
      ...(refs === undefined ? {} : { refs: [...refs] }),
    }),
  touches: (out) => [out.entityId],
  found: () => 1,
  input: ({ entity }) => entity,
  proposal: true,
})

// Ask's action card: a proposal shown beside the answer, never applied by
// the agent. Attribute values stay `propose_suggestion`'s.
const proposeCard = defineTool({
  name: 'propose_card',
  title: 'Propose an action card',
  description:
    'Offer the reader one action beside your answer: create a task on a record, move a deal to another stage, or file a record into a space. Nothing is written: the reader applies or skips the card, and an undecided card waits in Review. Cite the evidence the card rests on as refs this turn retrieved. One card per action and record; never use a card for attribute values (propose_suggestion does that).',
  decoder: proposeCardInput,
  inputSchema: proposeCardJsonSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: (caller, input) => proposeCardProgram(proposerOf(caller), input),
  touches: (out) => [out.record.id],
  found: () => 1,
  input: ({ kind, record }) => `${kind} ${record}`,
  card: (out) => out,
  proposal: true,
  value: (out) => ({
    proposed: out.kind,
    record: out.record.name,
    summary: out.summary,
    note: 'Shown to the reader as a card. Nothing changes until they apply it.',
  }),
})

const searchRecords = defineTool({
  name: 'search_records',
  title: 'Search records',
  description:
    'Search Spaces the way its Cmd-K box does — record names and aliases (typo-tolerant), note bodies, document text, tasks, and meaning when an embedding model is configured — fused into one ranked list of at most 20 hits. Each hit carries its id (pass it to get_record or get_context), kind, name, object, and a snippet marked «like this». Pass `object` to keep only one object’s records.',
  decoder: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    object: Schema.optional(nonEmpty),
  }),
  inputSchema: {
    $schema: DRAFT_07,
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'What to look for',
      },
      object: {
        description:
          'An object’s slug, singular or plural name (see list_registry); only its records are returned',
        type: 'string',
        minLength: 1,
      },
    },
    required: ['query'],
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

// Structured questions over the views compiler, never generated SQL.
const queryRecords = defineTool({
  name: 'query_records',
  title: 'Query records',
  description: `Records of one object that meet conditions, sorted, with the total that match — computed in the database by the same compiler as the list pages’ filters and view counts, never estimated and never summarised. Conditions are keyed by attribute slug (see list_registry) with ops is, is_not, contains, empty, not_empty, gt, lt; a bare value means "is". A space condition {id, includeDescendants} keeps records filed in that space and, by default, any space below it. The interaction columns last_interaction, first_email, last_email and next_meeting filter as days and sort by time. Each row carries its id (pass it to get_record or get_context), name, stored values and sort value; at most ${QUERY_RECORDS_MAX} rows, and total counts them all. An unknown attribute or space is refused by name.`,
  decoder: queryRecordsInput,
  inputSchema: queryRecordsJsonSchema,
  annotations: readOnly,
  run: (caller, input) => queryRecordsProgram({ id: caller.userId }, input),
  touches: (out) => out.rows.map((r) => r.id),
  found: (out) => out.total,
  input: ({ object }) => object,
})

// Money over the pure portfolio libraries, never generated.
const portfolioSummary = defineTool({
  name: 'portfolio_summary',
  title: 'Portfolio summary',
  description:
    'The portfolio as the Portfolio page reads it, computed from the event ledger rather than estimated: per holding and for the whole book, invested (cost basis), value (what is still held — the latest mark, or cost when never marked), distributions (cash returned), TVPI, DPI and gross IRR (annualized; 0.15 is 15%). Money is plain numbers in the named currency: each holding in its own currency when all its events share one, else base; the total always in base. A holding missing an exchange rate has null figures, names the rates it needs, and is left out of the total. Each holding carries its id for holding_detail.',
  decoder: portfolioSummaryInput,
  inputSchema: portfolioSummaryJsonSchema,
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
  decoder: holdingDetailInput,
  inputSchema: holdingDetailJsonSchema,
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
  decoder: Schema.Struct({ object: Schema.optional(nonEmpty) }),
  inputSchema: {
    $schema: DRAFT_07,
    type: 'object',
    properties: {
      object: {
        description:
          'Just this object — its slug, singular or plural name; omit for all',
        type: 'string',
        minLength: 1,
      },
    },
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
 * A tool's input as Ask's model is shown it, and checked by the tool's own
 * decode before the call runs, so a refused call never reaches `execute`.
 */
export const modelInputSchema = (tool: RegisteredTool) =>
  modelSchema(closedObjects(tool.inputSchema), tool.decode)

/** Ask's tools: the MCP table and the action card, which is Ask's alone. */
export const ASK_TOOLS: ReadonlyArray<RegisteredTool> = [
  ...MCP_TOOLS,
  proposeCard,
]

/**
 * The door both clients call. A method on an object, so a test can spy on
 * it and see every call either client makes.
 */
export const toolRegistry = {
  tools: MCP_TOOLS,
  askTools: ASK_TOOLS,
  call(
    name: string,
    caller: ToolCaller,
    raw: unknown,
  ): Effect.Effect<ToolAnswer, ToolFailure> {
    const table = caller.proposer.kind === 'ask' ? ASK_TOOLS : MCP_TOOLS
    const tool = table.find((t) => t.name === name)
    return tool === undefined
      ? Effect.fail(new McpToolRefused({ message: `No tool ${name}` }))
      : tool.invoke(caller, raw)
  },
}
