import { Context, Effect, Schema } from 'effect'
import type { Redacted } from 'effect'
import { z } from 'zod'
import { JobPermanent } from './contract.ts'
import type {
  AliasClaim,
  AnswerClaim,
  DiscoverClaim,
  DocumentClaim,
  EntityId,
  FactClaim,
  IdentityClaim,
  ImportGrid,
  IsoTimestamp,
  InteractionClaim,
  JobError,
  JsonObject,
  JsonValue,
  JudgmentClaim,
  PortName,
  ReceiptClaim,
  Ref,
  SignalClaim,
  WatchInput,
} from './contract.ts'
import type { AuthoredManifest } from './manifest.ts'

/**
 * The ports (docs/spec-plugin-sdk.md §4). Effect service tags
 * and no implementations: a plugin imports these, core implements them over
 * the real database (`packages/core/src/writes/ports/`, sdk-6a…sdk-10), and
 * the loader provides the implementations bound to one `integration` row,
 * holding exactly the ports the job's `uses` names (D51).
 *
 * The house pattern (the one SPA-182's `SimilarLane` copies):
 *
 *   export class X extends Context.Service<X, Shape>()('spaces/…/X') {}
 *
 * **The service keys are part of the contract.** A key is how the host's
 * Layer finds the tag a bundle yields; a renamed key is "service not found"
 * in every installed plugin, so `ports.test.ts` snapshots the list and a
 * rename there is an SDK major.
 *
 * **A write port returns what its lane decided (D52)** — the id it wrote, or
 * the conflicts it refused — and fails with a `JobError`, the three outcomes
 * `runJob` maps, so a port failure propagates out of a job unchanged.
 *
 * Clock is deliberately not a port: Effect ships one, and plugin code reads
 * time through it (`Clock.currentTimeMillis`, `DateTime.now`). The plugin
 * eslint zone refuses `Date.now()` and `new Date()` there.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * What `Identity.resolve` decided. `attached`: the keys already identified
 * this entity. `created`: they identified nothing, so it was born. A key
 * held by a *different* entity is still `attached` to the one that matched
 * first, and the lane records the collision as a `duplicate_candidate` for
 * a human — never an error, never a second entity.
 */
export type ResolveOutcome = 'attached' | 'created'

export type ResolveResult = {
  readonly entityId: EntityId
  readonly outcome: ResolveOutcome
}

/** Per key: added, already this entity's, or held elsewhere (a candidate). */
export type AliasOutcome = 'added' | 'already_own' | 'suggested_duplicate'

export type AliasResult = {
  readonly keys: ReadonlyArray<{
    readonly key: 'domain' | 'email' | 'linkedin'
    readonly outcome: AliasOutcome
  }>
}

export class Identity extends Context.Service<
  Identity,
  {
    readonly resolve: (
      claim: IdentityClaim,
    ) => Effect.Effect<ResolveResult, JobError>
    readonly addAlias: (
      claim: AliasClaim,
    ) => Effect.Effect<AliasResult, JobError>
  }
>()('spaces/sdk/Identity') {}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** A value `Facts.fill` refused because a human's value is already there. */
export type FactConflict = {
  readonly slug: string
  readonly existing: JsonValue
  readonly proposed: JsonValue
}

export type FillResult = { readonly conflicts: ReadonlyArray<FactConflict> }

/**
 * Fill blanks only (the lane is `setValues`). A value this integration wrote
 * before is updated in place; a value a human wrote is refused and returned
 * — and becomes one suggestion — so the job can see what it could not say.
 * - A value a person cleared stays cleared: skipped, neither written nor
 *   returned.
 * - A relationship (a record reference) fills only when empty; any held
 *   value that differs is returned and proposed, even this integration's.
 */
/**
 * What `Facts.answer` decided about each key, before any value is written:
 * `linked` keys reach an attribute of the record's object, `unlinked` ones
 * reach none and are only kept in the receipt.
 */
export type AnswerResult = {
  readonly linked: ReadonlyArray<string>
  readonly unlinked: ReadonlyArray<string>
}

/**
 * - `fill`: by slug, for writers that are not enrichment sources.
 * - `answer` (SDK 1.3): an enrichment source's answers, by vocabulary key
 *   (D76). A key outside `ENRICHMENT_VOCABULARY`, or a value of the wrong
 *   shape, fails the call permanently naming the key. The host applies the
 *   enrichment rules: blanks fill, a person's value is never touched (a
 *   disagreement becomes one Review card per record), another source's
 *   value stands unless it is an older changing figure.
 */
export class Facts extends Context.Service<
  Facts,
  {
    readonly fill: (claim: FactClaim) => Effect.Effect<FillResult, JobError>
    readonly answer: (
      claim: AnswerClaim,
    ) => Effect.Effect<AnswerResult, JobError>
  }
>()('spaces/sdk/Facts') {}

// ---------------------------------------------------------------------------
// Content, Judgment, Receipts
// ---------------------------------------------------------------------------

export class Content extends Context.Service<
  Content,
  {
    /** Through core's intake: the size meter, dedupe and birth a hand upload gets. */
    readonly fileDocument: (
      claim: DocumentClaim,
    ) => Effect.Effect<{ readonly documentId: string }, JobError>
    /** One row per `messageId`; a claim without one is a new row each time. */
    readonly logInteraction: (
      claim: InteractionClaim,
    ) => Effect.Effect<{ readonly interactionId: string }, JobError>
    readonly emitSignal: (
      claim: SignalClaim,
    ) => Effect.Effect<{ readonly signalId: string }, JobError>
  }
>()('spaces/sdk/Content') {}

/** The review inbox: a proposal, never a silent write, never pre-accepted. */
export class Judgment extends Context.Service<
  Judgment,
  {
    readonly suggest: (
      claim: JudgmentClaim,
    ) => Effect.Effect<{ readonly suggestionId: string }, JobError>
  }
>()('spaces/sdk/Judgment') {}

/** `enrichment_record`: the raw response, kept whole — the provenance anchor. */
export class Receipts extends Context.Service<
  Receipts,
  {
    readonly store: (
      claim: ReceiptClaim,
    ) => Effect.Effect<{ readonly receiptId: string }, JobError>
  }
>()('spaces/sdk/Receipts') {}

// ---------------------------------------------------------------------------
// Ai
// ---------------------------------------------------------------------------

/** The AI substrate's lanes a plugin may call (docs/spec-ai-substrate.md). */
export type AiLane = 'extract' | 'classify' | 'synthesize'

/** One piece of context, citable by its ref. */
export type AiItem = { readonly ref: Ref; readonly text: string }

/**
 * Lane + budget, never a model or a key. Metered and sensitivity-gated by
 * the port whoever calls it; cost is attributed to the bound integration.
 */
export class Ai extends Context.Service<
  Ai,
  {
    readonly complete: {
      (
        lane: AiLane,
        items: ReadonlyArray<AiItem>,
      ): Effect.Effect<string, JobError>
      <TResult>(
        lane: AiLane,
        items: ReadonlyArray<AiItem>,
        schema: z.ZodType<TResult>,
      ): Effect.Effect<TResult, JobError>
    }
  }
>()('spaces/sdk/Ai') {}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type RecordKind = 'company' | 'person' | 'deal'

/** A record as an integration may see it (`canRead` as actor integration). */
export type ReadEntity = {
  readonly id: EntityId
  readonly kind: RecordKind
  readonly name: string
  /** Identity keys by kind, normalized — a company's domains, a person's emails. */
  readonly keys: {
    readonly domain: ReadonlyArray<string>
    readonly email: ReadonlyArray<string>
    readonly linkedin: ReadonlyArray<string>
  }
  /** Attribute values by slug. */
  readonly values: JsonObject
}

export type SearchHit = {
  readonly entityId: EntityId
  readonly kind: RecordKind
  readonly name: string
}

export type SearchOptions = {
  readonly kinds?: ReadonlyArray<RecordKind>
  readonly limit?: number
}

/**
 * The plugin's view of the graph. `entity` is null for an id that does not
 * exist *and* for one the integration may not read — deliberately the same
 * answer. `search` is lexical + fuzzy in v1 (D56).
 */
export class Read extends Context.Service<
  Read,
  {
    readonly entity: (
      id: EntityId,
    ) => Effect.Effect<ReadEntity | null, JobError>
    readonly search: (
      query: string,
      options?: SearchOptions,
    ) => Effect.Effect<ReadonlyArray<SearchHit>, JobError>
  }
>()('spaces/sdk/Read') {}

// ---------------------------------------------------------------------------
// Secrets, Config
// ---------------------------------------------------------------------------

/**
 * No OAuth connection for this integration — not granted, revoked, or (until
 * the storage area builds `Secrets.accessToken`) not implemented. A job
 * decides what that means for it; usually `JobPermanent`.
 */
export class NotConnected extends Schema.TaggedError<NotConnected>()(
  'NotConnected',
  { reason: Schema.String },
) {}

/**
 * The bound row's credential, decrypted in the worker only. `accessToken` is
 * declared now so adding it later is not an SDK major; its live
 * implementation belongs to the storage area and fails `NotConnected` until
 * then.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    /** The workspace credential `requires.credential` named. */
    readonly get: () => Effect.Effect<Redacted.Redacted<string>, JobPermanent>
    /** A fresh OAuth access token for `requires.connection`. */
    readonly accessToken: () => Effect.Effect<
      Redacted.Redacted<string>,
      NotConnected
    >
  }
>()('spaces/sdk/Secrets') {}

/**
 * `integration.config` as stored — an object the loader validated against
 * `manifest.settings`. `configOf(manifest)` is the typed read.
 */
export class Config extends Context.Service<
  Config,
  { readonly get: () => Effect.Effect<JsonObject> }
>()('spaces/sdk/Config') {}

/**
 * The config, parsed by the manifest's own settings schema — defaults
 * applied, typed as the plugin authored it. A config that does not parse is
 * a permanent failure: retrying reads the same row.
 */
export const configOf = <TSettings extends z.ZodType>(
  manifest: Pick<AuthoredManifest, 'id'> & { readonly settings: TSettings },
): Effect.Effect<z.output<TSettings>, JobPermanent, Config> =>
  Effect.gen(function* () {
    const raw = yield* (yield* Config).get()
    const parsed = z.safeParse(manifest.settings, raw)
    if (parsed.success) return parsed.data
    return yield* new JobPermanent({
      reason: `${manifest.id}'s settings do not match its manifest: ${parsed.error.message}`,
    })
  })

// ---------------------------------------------------------------------------
// PluginDb
// ---------------------------------------------------------------------------

/**
 * SQL in the plugin's own Postgres schema, `plugin_<id>` (hyphens become
 * underscores). The SDK cannot depend on drizzle, so the surface is
 * parameterised SQL and rows as JSON.
 *
 * - One statement per call, in its own transaction, as the `plugin_runtime`
 *   role: unqualified names resolve in `plugin_<id>` then `public`; reading
 *   `public.*` works, writing it is refused by Postgres.
 * - The schema's tables come from the package's `migrations/*.sql`, applied
 *   at load in lexical order against the plugin's own journal, forward-only.
 *   An FK to `public.entity(id)` is allowed; nothing in `public` points back.
 * - A refused statement is `JobPermanent`; a lost connection `JobRetryable`.
 */
export class PluginDb extends Context.Service<
  PluginDb,
  {
    readonly query: (
      sql: string,
      params?: ReadonlyArray<JsonValue>,
    ) => Effect.Effect<ReadonlyArray<JsonObject>, JobError>
  }
>()('spaces/sdk/PluginDb') {}

// ---------------------------------------------------------------------------
// Http, Log
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type HttpRequest = {
  readonly method: HttpMethod
  readonly url: string
  readonly headers?: { readonly [name: string]: string }
  /** A string is sent as-is; anything else as JSON. */
  readonly body?: string | JsonValue
}

export type HttpResponse = {
  readonly status: number
  /** Lower-cased names. */
  readonly headers: { readonly [name: string]: string }
  readonly body: string
}

/**
 * A response whose body is handed over as it arrives — a file download.
 * The caller reads the body to its end or cancels it; an unread body holds
 * the connection open.
 */
export type HttpStreamResponse = {
  readonly status: number
  /** Lower-cased names. */
  readonly headers: { readonly [name: string]: string }
  readonly body: ReadableStream<Uint8Array>
}

/**
 * Rate-limited fetch — no raw `fetch` in a plugin. The live port throttles on
 * `Retry-After` / `X-RateLimit-*`, injects the credential where the manifest
 * says, and maps a 429 to `JobRateLimited`; any other status comes back as a
 * response for the job to judge.
 *
 * - `request` reads the body as text: JSON and feeds.
 * - `stream` never buffers the body and never decodes it: bytes, of any
 *   size. Same throttle, same 429 rule.
 */
export class Http extends Context.Service<
  Http,
  {
    readonly request: (
      request: HttpRequest,
    ) => Effect.Effect<HttpResponse, JobError>
    readonly stream: (
      request: HttpRequest,
    ) => Effect.Effect<HttpStreamResponse, JobError>
  }
>()('spaces/sdk/Http') {}

/** A response body as JSON, or a permanent failure naming the URL. */
export const responseJson = (
  response: HttpResponse,
  url: string,
): Effect.Effect<unknown, JobPermanent> =>
  Effect.try({
    try: (): unknown => JSON.parse(response.body),
    catch: () =>
      new JobPermanent({ reason: `${url} returned a body that is not JSON` }),
  })

export type LogFields = { readonly [key: string]: JsonValue }

/** Lines prefixed `[plugin:<id>]` by the live port. */
export class Log extends Context.Service<
  Log,
  {
    readonly info: (message: string, fields?: LogFields) => Effect.Effect<void>
    readonly warn: (message: string, fields?: LogFields) => Effect.Effect<void>
    readonly error: (message: string, fields?: LogFields) => Effect.Effect<void>
  }
>()('spaces/sdk/Log') {}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A row the port could not read, by its ordinal, and why. */
export type ImportRefusal = {
  readonly ordinal: number
  readonly reason: string
}

/**
 * What `Import.stage` landed.
 * - `staged` counts every placed row, the malformed ones included.
 * - `malformed`: placed under its ordinal with no cells, so it plans as
 *   `no-land` and the rest of the batch commits.
 * - `refused`: no usable ordinal, so not placed at all.
 */
export type StageResult = {
  readonly batchId: string
  readonly staged: number
  readonly malformed: ReadonlyArray<ImportRefusal>
  readonly refused: ReadonlyArray<ImportRefusal>
}

/**
 * A dialect's grid into the import batch the wizard is waiting on (D39 as
 * amended). Core walks it through the same mapping, preview, commit and
 * batch void as a hand-mapped CSV; the plugin never maps or commits. Only a
 * `file` job the import wizard started has a batch to stage into — anything
 * else fails permanently. Staging twice writes nothing the second time.
 */
export class Import extends Context.Service<
  Import,
  {
    readonly stage: (grid: ImportGrid) => Effect.Effect<StageResult, JobError>
  }
>()('spaces/sdk/Import') {}

// ---------------------------------------------------------------------------
// Spaces, Discover — a watch's subject and its hand-back (D72)
// ---------------------------------------------------------------------------

/** One space on the way to the brief's subject, root first. */
export type SpaceBriefStep = {
  readonly id: EntityId
  readonly name: string
}

/** A memo filed on the space or an ancestor, shared notes only. */
export type SpaceBriefMemo = {
  readonly ref: Ref
  /** The space it is filed on: the subject's, or an ancestor's. */
  readonly spaceId: EntityId
  readonly title: string
  /** Markdown, clipped. */
  readonly body: string
  readonly updatedAt: IsoTimestamp
}

/** A glossary term scoped to the space or an ancestor. */
export type SpaceBriefTerm = {
  readonly ref: Ref
  readonly spaceId: EntityId
  readonly name: string
  readonly aliases: ReadonlyArray<string>
  readonly definition: string
}

/** A company filed in the space or a subspace, with its key values. */
export type SpaceBriefMember = {
  readonly entityId: EntityId
  readonly name: string
  /** The space it is filed in: the subject or one of its subspaces. */
  readonly spaceId: EntityId
  /** Normalized identity domains. */
  readonly domains: ReadonlyArray<string>
  /** Key attribute values by slug, as stored; an unset one is absent. */
  readonly values: JsonObject
}

/** The subtree under the subject, each node with what is filed on it. */
export type SpaceBriefNode = {
  readonly id: EntityId
  readonly name: string
  /** Companies filed on this node itself. */
  readonly companies: number
  readonly children: ReadonlyArray<SpaceBriefNode>
}

/**
 * What a space is, as data an engine turns into its own query — never a
 * rendered prompt. (D71, D72)
 * - `members` is capped; `memberCount` is the whole.
 * - Sensitive members and sensitive subspaces are left out.
 */
export type SpaceBrief = {
  readonly space: {
    readonly id: EntityId
    readonly name: string
    /** What belongs here, as the owner wrote it; null when unwritten. */
    readonly criteria: string | null
  }
  /** Root first, ending with the subject. */
  readonly path: ReadonlyArray<SpaceBriefStep>
  readonly memos: ReadonlyArray<SpaceBriefMemo>
  readonly terms: ReadonlyArray<SpaceBriefTerm>
  readonly members: ReadonlyArray<SpaceBriefMember>
  readonly memberCount: number
  readonly tree: SpaceBriefNode
}

/**
 * The space as a watch's subject. Read-only, as the bound integration
 * (`canRead`): a space that does not exist, is archived, or is sensitive
 * anywhere in its path fails the call permanently — which fails the run.
 */
export class Spaces extends Context.Service<
  Spaces,
  {
    readonly brief: (spaceId: EntityId) => Effect.Effect<SpaceBrief, JobError>
  }
>()('spaces/sdk/Spaces') {}

/**
 * A watch's hand-back: one candidate company for a space. `suggestionId` is
 * the card it made or joined; null when the host dropped it — already a
 * member, or dismissed for this space.
 */
export class Discover extends Context.Service<
  Discover,
  {
    readonly candidate: (
      claim: DiscoverClaim,
    ) => Effect.Effect<{ readonly suggestionId: string | null }, JobError>
  }
>()('spaces/sdk/Discover') {}

/**
 * A watch run's settings, parsed by the job's own `settings` schema —
 * defaults applied, typed as authored. Settings that do not parse are a
 * permanent failure: retrying reads the same row.
 */
export const watchSettingsOf = <TSettings extends z.ZodType>(
  job: { readonly settings: TSettings },
  input: Pick<WatchInput, 'watchId' | 'settings'>,
): Effect.Effect<z.output<TSettings>, JobPermanent> => {
  const parsed = z.safeParse(job.settings, input.settings)
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new JobPermanent({
          reason: `watch ${input.watchId}'s settings do not match its job: ${parsed.error.message}`,
        }),
      )
}

// ---------------------------------------------------------------------------
// The name → tag map (D51's grant)
// ---------------------------------------------------------------------------

/** The tag for each name in `PORT_NAMES` — what the loader builds a Layer from. */
export const PORTS = {
  Identity,
  Facts,
  Content,
  Judgment,
  Receipts,
  Ai,
  Read,
  Secrets,
  Config,
  PluginDb,
  Http,
  Log,
  Import,
  Spaces,
  Discover,
} as const satisfies { readonly [K in PortName]: unknown }

/**
 * The service each port name grants, as it appears in an Effect's `R`.
 * Spelled out rather than `InstanceType<typeof PORTS[N]>`, which collapses
 * to `any` on a v4 service class — and an `any` here would let every job
 * yield every port.
 */
export type PortServices = {
  readonly Identity: Identity
  readonly Facts: Facts
  readonly Content: Content
  readonly Judgment: Judgment
  readonly Receipts: Receipts
  readonly Ai: Ai
  readonly Read: Read
  readonly Secrets: Secrets
  readonly Config: Config
  readonly PluginDb: PluginDb
  readonly Http: Http
  readonly Log: Log
  readonly Import: Import
  readonly Spaces: Spaces
  readonly Discover: Discover
}

export type PortService<TName extends PortName> = PortServices[TName]
