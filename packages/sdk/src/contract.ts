import { Schema } from 'effect'
import type { Effect } from 'effect'

/**
 * The semver-frozen contract (sdk-4a; docs/spec-plugin-sdk.md §4–§5 as
 * amended 2026-09-30 by D51–D53). Everything a plugin's code is typed
 * against lives in this one file so it can be read, and reviewed, as one:
 * the port names, the claims (the typed arguments of the write-port
 * methods), the five trigger shapes, the cost hook and the job errors.
 * Once published it moves only on a major — a new trigger, port, claim
 * variant or optional field is a minor; any changed shape is a major.
 *
 * Two rules hold across every claim below (D52):
 *
 * - **No provenance.** No claim carries `source`, `actor`, `actorType`,
 *   `integrationId` or `sourceRef` — who wrote what is the port's, stamped
 *   from the bound `integration` row (`contract.test.ts` asserts it over
 *   every claim type). A plugin cannot forge it because it cannot say it.
 * - **No handles.** A claim names existing things by id; the ids come back
 *   from the write port that made them (`Identity.resolve` → the entity id
 *   the next `Facts.fill` uses). Dependency order is the job's code order.
 */

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A JSON value — what a column of type jsonb can hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

/** An entity row's id (a uuid). Merged losers resolve at read time. */
export type EntityId = string

/** An ISO-8601 timestamp, e.g. `2026-09-30T12:00:00Z`. */
export type IsoTimestamp = string

/**
 * A citation in the shipped ref grammar — the one and only citation format
 * (D4; `@spaces/core/context/ref`). A URL is not a ref: cite the signal the
 * URL was emitted as (`event:<signalId>`, the id `Content.emitSignal`
 * returns), so a reviewer's click lands on a row in the graph.
 */
export type Ref =
  | `attr:${EntityId}:${string}`
  | `note:${EntityId}`
  | `memo:${EntityId}`
  | `doc:${EntityId}#${number}`
  | `event:${string}`
  | `interaction:${string}`
  | `task:${string}`
  | `mandate:${string}`
  | `term:${EntityId}`

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The ports a job may declare in `uses` (D51) — twelve, the spec §4 table
 * minus Clock (Effect ships one; plugin code reads time through it). The
 * manifest validates `uses` against this list, sdk-5 declares a service tag
 * per name, and the loader builds a job's Layer from exactly the names it
 * lists.
 */
export const PORT_NAMES = [
  'Identity',
  'Facts',
  'Content',
  'Judgment',
  'Receipts',
  'Ai',
  'Read',
  'Secrets',
  'Config',
  'PluginDb',
  'Http',
  'Log',
] as const
export type PortName = (typeof PORT_NAMES)[number]

// ---------------------------------------------------------------------------
// Claims — the typed arguments of the write-port methods (D52)
// ---------------------------------------------------------------------------

/** The kinds an identity can be resolved to. A deal has no identity keys. */
export type IdentityKind = 'company' | 'person'

/**
 * Identity keys, as the provider gave them — the port normalizes (sdk-4b
 * puts the one normalizer in this package so plugin and choke point agree).
 */
export type IdentityKeys = {
  readonly domain?: string
  readonly email?: string
  readonly linkedin?: string
  readonly cin?: string
}

/**
 * `Identity.resolve(kind, keys, name?)`: attach to the entity these keys
 * identify, or create one. A key that already identifies a *different*
 * entity is the lane's to judge (a `duplicate_candidate`), never an error.
 * At least one key or a name is required — the choke point refuses a claim
 * with neither.
 */
export type IdentityClaim = {
  readonly kind: IdentityKind
  readonly keys: IdentityKeys
  readonly name?: string
}

/** `Identity.addAlias(entityId, keys)`: more keys for a known entity. */
export type AliasClaim = {
  readonly entityId: EntityId
  readonly keys: IdentityKeys
}

/** Attribute values by slug, validated by the attribute registry in the lane. */
export type FactValues = { readonly [slug: string]: JsonValue }

/**
 * `Facts.fill(entityId, values, evidence?)`: fill blanks only. A value that
 * would overwrite a human's is refused and returned as a conflict (which
 * becomes a suggestion); a value this integration wrote before is updated.
 * `receiptId` — the id `Receipts.store` returned for the payload these
 * values came from — rides along as the attribute events' `refs`, so a
 * filled value can be traced to the raw response. It is evidence, not
 * provenance: who filled it is still the port's.
 */
export type FactClaim = {
  readonly entityId: EntityId
  readonly values: FactValues
  readonly receiptId?: string
}

/** `Receipts.store(…)`: the raw provider response, kept whole (the provenance anchor). */
export type ReceiptClaim = {
  readonly entityId: EntityId
  readonly raw: JsonValue
  /** In the provider's own unit; spend is counted from these (D53). */
  readonly creditsUsed?: number
}

/** The document kinds a claim may name (the `document_kind` enum). */
export const DOCUMENT_KINDS = [
  'deck',
  'dd',
  'cap_table',
  'legal',
  'article',
  'other',
] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

/** Where a filed document goes: onto a record, or into a space. */
export type FilingTarget = {
  readonly kind: 'record' | 'space'
  readonly entityId: EntityId
}

/** The bytes of a document: a stream read once, or bytes already in hand. */
export type DocumentBytes =
  | { readonly stream: ReadableStream<Uint8Array> }
  | { readonly bytes: Uint8Array }

/**
 * `Content.fileDocument(claim)`: bytes through core's intake — the same
 * size meter, content-hash dedupe and birth a hand upload gets.
 */
export type DocumentClaim = {
  readonly _tag: 'document'
  readonly body: DocumentBytes
  readonly filename: string
  readonly mime: string | null
  /** Omitted → `other`; the classifier may propose better. */
  readonly kind?: DocumentKind
  readonly fileAgainst: ReadonlyArray<FilingTarget>
  /** The page these bytes are the text of, when there is one. */
  readonly url?: string
}

export type InteractionKind = 'email' | 'meeting' | 'call'

/**
 * `Content.logInteraction(claim)`: one interaction and an edge per entity.
 * `messageId` is the lane's dedupe key — the same id twice is one row; no
 * id is a new row every time, as on the manual path.
 */
export type InteractionClaim = {
  readonly _tag: 'interaction'
  readonly kind: InteractionKind
  readonly occurredAt: IsoTimestamp
  readonly entityIds: readonly [EntityId, ...Array<EntityId>]
  readonly subject?: string
  readonly messageId?: string
  readonly threadId?: string
  /** The write-up, plain text; becomes the interaction's note. */
  readonly body?: string
}

/**
 * `Content.emitSignal(claim)`: a dated observation about one entity — a web
 * mention, a funding round, a hire. Evidence, not a fact: it never touches
 * an attribute.
 */
export type SignalClaim = {
  readonly _tag: 'signal'
  readonly entityId: EntityId
  /** Open vocabulary (`web`, `funding`, `hiring`, …). */
  readonly kind: string
  readonly title?: string
  readonly url?: string
  readonly publishedAt?: IsoTimestamp
  /** Anything else the provider said, kept whole. */
  readonly payload?: JsonObject
}

/**
 * The three Content claims, told apart by `_tag`: an interaction carrying a
 * document's `body` or `fileAgainst` is not an interaction claim.
 */
export type ContentClaim = DocumentClaim | InteractionClaim | SignalClaim

/** A note the reviewer may accept onto the record. */
export type NoteProposal = { readonly kind: 'note'; readonly body: string }

/** One attribute value the reviewer may accept. */
export type AttributeProposal = {
  readonly kind: 'attribute'
  readonly slug: string
  readonly value: JsonValue
}

export type Proposal = NoteProposal | AttributeProposal

/**
 * `Judgment.suggest(claim)`: a proposal for the review inbox — never a
 * silent write, and never already accepted. `rationale` and `refs` are what
 * the reviewer sees to decide.
 */
export type JudgmentClaim = {
  readonly entityId: EntityId
  readonly proposal: Proposal
  readonly rationale: string
  readonly refs: ReadonlyArray<Ref>
}

// ---------------------------------------------------------------------------
// Job errors — what a job may fail with, and what runJob maps
// ---------------------------------------------------------------------------

/**
 * The three typed outcomes a job can fail with. The tags are the worker's
 * (`apps/worker/src/run-job.ts`: `JobRetryable`, `JobRateLimited`,
 * `JobPermanent`), so runJob maps a plugin's failure exactly as it maps a
 * core job's: retry on the queue's policy, re-send after the throttle
 * without spending a retry, or fail now.
 */
export class JobRetryable extends Schema.TaggedError<JobRetryable>()(
  'JobRetryable',
  { reason: Schema.String },
) {}

export class JobRateLimited extends Schema.TaggedError<JobRateLimited>()(
  'JobRateLimited',
  { reason: Schema.String, retryAfterMs: Schema.Number },
) {}

export class JobPermanent extends Schema.TaggedError<JobPermanent>()(
  'JobPermanent',
  { reason: Schema.String },
) {}

export type JobError = JobRetryable | JobRateLimited | JobPermanent

// ---------------------------------------------------------------------------
// Triggers (D51) — each fixes what a job is handed and returns
// ---------------------------------------------------------------------------

/**
 * The domain events an `event` job may subscribe to (`jobs[name].on`).
 * Closed: a new event is a minor.
 */
export const DOMAIN_EVENTS = ['entity.created'] as const
export type DomainEventName = (typeof DOMAIN_EVENTS)[number]

export type DomainEvent = {
  readonly name: 'entity.created'
  readonly entityId: EntityId
  readonly kind: 'company' | 'person' | 'deal'
  readonly occurredAt: IsoTimestamp
}

/** `action` — the "Enrich" button; one record. */
export type ActionInput = { readonly entityId: EntityId }
export type ActionRun<TServices = unknown> = (
  input: ActionInput,
) => Effect.Effect<void, JobError, TServices>

/**
 * The cost hook (D53): pure, in the provider's own unit. The host drops
 * entities with a fresh receipt, asks this about the rest, and refuses
 * before any API call when the estimate does not fit the daily cap.
 */
export type CostInput = {
  readonly entityIds: ReadonlyArray<EntityId>
  readonly fields?: ReadonlyArray<string>
}
export type CostHook = (input: CostInput) => { readonly credits: number }

/** An action job: the run function, or the run function plus `cost`. */
export type ActionJob<TServices = unknown> =
  | ActionRun<TServices>
  | { readonly run: ActionRun<TServices>; readonly cost?: CostHook }

/** `schedule` — Gmail, Calendar: resume from the cursor, hand back the next. */
export type ScheduleInput = { readonly cursor: string | null }
export type ScheduleOutput = { readonly nextCursor: string | null }
export type ScheduleJob<TServices = unknown> = (
  input: ScheduleInput,
) => Effect.Effect<ScheduleOutput, JobError, TServices>

/** `event` — enrich-on-create and its kin. */
export type EventInput = { readonly event: DomainEvent }
export type EventJob<TServices = unknown> = (
  input: EventInput,
) => Effect.Effect<void, JobError, TServices>

/** What the ingress stored, after core verified it. */
export type WebhookInput = {
  readonly payload: JsonValue
  readonly receivedAt: IsoTimestamp
}

/**
 * `webhook` — call recorders. A plain job on the stored payload, like the
 * others. There is no plugin-side `verify` (checkpoint review, 2026-10-01):
 * plugin code runs only in the worker, after web has already answered the
 * provider, so a plugin check could gate nothing — and running one in web
 * would break "web never executes plugin code". The signature is
 * manifest-declared (`ingress.signature`) and core checks it in web (sdk-23)
 * before the payload is stored. If a provider ever needs a plugin-side
 * check, it arrives as an optional field — a minor.
 */
export type WebhookJob<TServices = unknown> = (
  input: WebhookInput,
) => Effect.Effect<void, JobError, TServices>

/** `file` — an importer: CSV, a WhatsApp export. Speaks claims, never a grid (D39). */
export type FileInput = {
  readonly stream: ReadableStream<Uint8Array>
  readonly filename: string
  readonly mime: string | null
}
export type FileJob<TServices = unknown> = (
  input: FileInput,
) => Effect.Effect<void, JobError, TServices>

/** A job's function (or object), by its trigger. */
export type JobFor<TTrigger, TServices = unknown> = TTrigger extends 'action'
  ? ActionJob<TServices>
  : TTrigger extends 'schedule'
    ? ScheduleJob<TServices>
    : TTrigger extends 'event'
      ? EventJob<TServices>
      : TTrigger extends 'webhook'
        ? WebhookJob<TServices>
        : TTrigger extends 'file'
          ? FileJob<TServices>
          : never
