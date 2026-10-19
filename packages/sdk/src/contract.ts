import { Schema } from 'effect'
import type { Effect } from 'effect'

/**
 * The semver-frozen contract (sdk-4a; docs/spec-plugin-sdk.md §4–§5 as
 * amended 2026-09-30 by D51–D53). Everything a plugin's code is typed
 * against lives in this one file so it can be read, and reviewed, as one:
 * the port names, the claims (the typed arguments of the write-port
 * methods), the six trigger shapes, the cost hook and the job errors.
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
 * The ports a job may declare in `uses` (D51) — the spec §4 table minus Clock
 * (Effect ships one; plugin code reads time through it). The manifest
 * validates `uses` against this list, each name has a service tag, and the
 * loader builds a job's Layer from exactly the names it lists.
 * - Appended only: `Import` arrived in SDK 1.1.0, `Spaces` and `Discover`
 *   in 1.5.0 — each a minor.
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
  'Import',
  'Spaces',
  'Discover',
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
 * A company is identified by its domain and a person by their email; a
 * LinkedIn URL identifies neither and only fills a new record's LinkedIn.
 */
export type IdentityKeys = {
  readonly domain?: string
  readonly email?: string
  readonly linkedin?: string
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

/**
 * `Facts.answer(entityId, answers, receiptId)`: what an enrichment source
 * knows, in the host's vocabulary (`ENRICHMENT_VOCABULARY`), never in
 * attribute slugs (D76). The host maps each key through the attribute that
 * links it; a key no attribute links is written nowhere and kept in the
 * run's receipt. `receiptId` is the raw response the answers came from.
 * `asOf` dates the figures when the source knows when they were true;
 * absent, they are as of the call.
 */
export type AnswerClaim = {
  readonly entityId: EntityId
  readonly answers: { readonly [key: string]: JsonValue }
  readonly receiptId: string
  readonly asOf?: IsoTimestamp
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
 * Someone on the interaction, by address (SDK 1.5). The host runs every one
 * through its participants module — the one mail and the calendar arrive
 * through — so the plugin never resolves a person itself.
 */
export type InteractionParticipant = {
  readonly email: string
  readonly name?: string
}

/**
 * What a recorder kept beside its payload (SDK 1.5), as an artifact of the
 * interaction (D68):
 * - `recording_link`: the provider's recording, kept as a link and never
 *   copied — a document with no bytes, "Open in <provider>".
 * - `transcript`, `attachment`: a document this integration already filed
 *   through `Content.fileDocument`.
 */
export type InteractionArtifact =
  | {
      readonly role: 'recording_link'
      readonly url: string
      /** The row's name on the Files tab; omitted → "Recording". */
      readonly title?: string
    }
  | {
      readonly role: 'transcript' | 'attachment'
      readonly documentId: string
    }

/**
 * A recorder's payload (SDK 1.5, D68): the host decides where it lands.
 * - It attaches to the calendar meeting `icalUid` names, else the one
 *   `calendarEventId` names, else the one starting within 30 minutes of
 *   `occurredAt` whose attendees include every participant email.
 * - Nothing matches: a `call` is born, keyed by `providerEventId`, so a
 *   payload delivered twice is one row.
 * - `raw` is stored whole as a receipt before anything is applied.
 * - What the recorder's notes become is the host's: a recorder claim
 *   carries no `body`.
 */
export type RecorderPayload = {
  readonly providerEventId: string
  readonly icalUid?: string
  readonly calendarEventId?: string
  readonly durationSeconds?: number
  readonly raw: JsonValue
  readonly artifacts?: ReadonlyArray<InteractionArtifact>
}

type InteractionClaimBase = {
  readonly _tag: 'interaction'
  readonly kind: InteractionKind
  readonly occurredAt: IsoTimestamp
  readonly subject?: string
  readonly messageId?: string
  readonly threadId?: string
}

type InteractionEdges =
  | {
      readonly entityIds: readonly [EntityId, ...Array<EntityId>]
      readonly participants?: ReadonlyArray<InteractionParticipant>
    }
  | {
      readonly entityIds?: readonly [EntityId, ...Array<EntityId>]
      readonly participants: readonly [
        InteractionParticipant,
        ...Array<InteractionParticipant>,
      ]
    }

type InteractionPayload =
  | {
      /** The write-up, plain text; becomes the interaction's note. */
      readonly body?: string
      readonly recorder?: never
    }
  | { readonly recorder: RecorderPayload; readonly body?: never }

/**
 * `Content.logInteraction(claim)`: one interaction and an edge per entity
 * and per participant — at least one of the two.
 * - `messageId` is the lane's dedupe key: the same id twice is one row; no
 *   id is a new row every time, as on the manual path.
 * - With `recorder` (SDK 1.5) the host matches the payload to a calendar
 *   meeting or births a `call`; `kind` and `messageId` are then the host's.
 */
export type InteractionClaim = InteractionClaimBase &
  InteractionEdges &
  InteractionPayload

/** A meeting's state on the calendar. A cancelled meeting is marked, never deleted (D68). */
export type MeetingStatus = 'scheduled' | 'cancelled'

/** An attendee's answer, shown and never edited (D68). */
export type MeetingRsvp = 'accepted' | 'declined' | 'tentative' | 'needs_action'

/**
 * One attendee, as the calendar lists them. The host runs every address
 * through its participants module — the same one mail arrives through — so
 * the plugin never resolves an attendee itself. Leave meeting rooms out.
 */
export type MeetingAttendee = {
  readonly email: string
  readonly name?: string
  readonly rsvp: MeetingRsvp
  /** This attendee is the connected calendar's owner. */
  readonly self?: boolean
}

/**
 * `Content.logMeeting(claim)` (SDK 1.5): one calendar event, born or followed
 * in place. `uid` is the row's key — the iCalendar UID, plus the recurrence
 * instant for one instance of a series — so the same meeting on two
 * connected calendars is one interaction.
 * - The host decides whether it is a meeting at all: an event with no
 *   outside attendee, or one the owner declined, or a cancelled one it never
 *   saw, writes nothing.
 * - A meeting it already holds follows the claim: time, status, attendees
 *   and their answers are rewritten on the same row.
 */
export type MeetingClaim = {
  readonly _tag: 'meeting'
  readonly uid: string
  /** The calendar's own id for the event. */
  readonly eventId: string
  readonly status: MeetingStatus
  readonly startsAt: IsoTimestamp
  readonly endsAt: IsoTimestamp
  readonly subject?: string
  /** The organizer's email. */
  readonly organizer?: string
  readonly conferenceUrl?: string
  /** The calendar's id for this instance when the event is one of a series. */
  readonly recurringInstanceId?: string
  readonly attendees: ReadonlyArray<MeetingAttendee>
}

/**
 * A cancellation that names nothing but the event — what a calendar's change
 * feed may send for a deleted event. The host marks the meeting it holds
 * under `uid`, else under `eventId`, as cancelled; it births nothing.
 */
export type MeetingCancellation = {
  readonly _tag: 'meeting-cancelled'
  readonly eventId: string
  readonly uid?: string
}

/**
 * What `Content.logMeeting` decided: the row it wrote or followed, or why
 * the event is not a meeting the workspace keeps.
 */
export type MeetingResult =
  | {
      readonly outcome: 'created' | 'updated'
      readonly interactionId: string
    }
  | { readonly outcome: 'refused'; readonly reason: string }

/**
 * `Content.logEmail(claim)` (SDK 1.5): one message from a connected mailbox,
 * handed over whole. The host decides everything else.
 * - The host parses `raw`, refuses noise and anything the connection's
 *   exclude list names before a byte is stored, resolves participants, files
 *   attachments and dedupes on the RFC Message-ID, so a thread both
 *   forwarded and synced is one interaction.
 * - Who may read the body is the host's (D67): the claim carries no
 *   visibility and must not grow one.
 */
export type EmailClaim = {
  readonly _tag: 'email'
  /** The provider's own id for the message (Gmail's `id`). */
  readonly providerMessageId: string
  /** The message's RFC 5322 bytes, base64url, as Gmail's `format=raw` returns them. */
  readonly raw: string
  /** When the mailbox received it (Gmail's `internalDate`). */
  readonly receivedAt: IsoTimestamp
  /** The labels the message carries, by name (`Inbox`, `Promotions`, a user label). */
  readonly labels: ReadonlyArray<string>
  /** The provider's plain-text preview of the body (Gmail's `snippet`), if it has one. */
  readonly snippet?: string
}

/** What `Content.logEmail` decided. `duplicate`: the Message-ID was already held. */
export type EmailResult =
  | { readonly outcome: 'created'; readonly interactionId: string }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'refused'; readonly reason: string }

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
  /**
   * The receipt (`Receipts.store`) the observation was read from; must be
   * one this integration stored. Cited as the signal's ref. (SDK 1.2)
   */
  readonly receiptId?: string
  /**
   * What makes the observation the same one on a re-run (`funding:Series
   * A:2024-03-01`). A keyed signal is written once per (record,
   * integration, key): a second emit writes nothing and hands back the
   * first signal's id. Unkeyed, every emit is a new signal.
   */
  readonly key?: string
}

/**
 * The Content claims, told apart by `_tag`: an interaction carrying a
 * document's `body` or `fileAgainst` is not an interaction claim.
 */
export type ContentClaim =
  | DocumentClaim
  | InteractionClaim
  | SignalClaim
  | MeetingClaim
  | MeetingCancellation
  | EmailClaim

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

/** A page a candidate was found on: the evidence a reviewer opens. */
export type DiscoveryEvidence = {
  readonly url: string
  readonly title?: string
}

/**
 * `Discover.candidate(claim)`: a company a watch found for a space. The host
 * decides what it becomes — nothing for a member or a dismissed domain, a
 * "file here" card for a known company, an "add" card for an unknown one —
 * and never creates a record or a deal from it. (D72)
 */
export type DiscoverClaim = {
  readonly spaceId: EntityId
  readonly name: string
  readonly domain: string
  readonly aliases?: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<DiscoveryEvidence>
  /** Signals the job emitted about it (`event:<signalId>`). */
  readonly refs?: ReadonlyArray<Ref>
  /** A subspace of `spaceId` the candidate belongs in, by name. */
  readonly subspaceHint?: string
}

/**
 * One cell of an import grid: text, or a list — a multi-select's labels,
 * several linked names, several URLs. The plugin splits a dialect's joined
 * cell; core lands it and the mapping reads it.
 */
export type ImportCell = string | ReadonlyArray<string>

/**
 * One data row. `ordinal` is its 1-based place among the file's data rows —
 * what a per-row error names, so it is the plugin's to say, not the order
 * rows happen to arrive in.
 */
export type ImportRow = {
  readonly ordinal: number
  readonly cells: ReadonlyArray<ImportCell>
}

/**
 * `Import.stage(grid)`: pre-mapping input (D39 as amended). The header and
 * the rows, nothing else — no target, no mapping, no values: mapping,
 * preview and commit are core's, exactly as for a hand-mapped CSV.
 */
export type ImportGrid = {
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ImportRow>
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
export const DOMAIN_EVENTS = [
  'entity.created',
  'filed',
  'deal.linked',
  'identity.added',
  'interaction.logged',
] as const
export type DomainEventName = (typeof DOMAIN_EVENTS)[number]

/** What every domain event names: the record it is about, and when. */
type DomainEventBase = {
  readonly entityId: EntityId
  readonly kind: 'company' | 'person' | 'deal'
  readonly occurredAt: IsoTimestamp
}

/**
 * One domain event, told apart by `name`:
 * - `entity.created`: a record was born (never by a seed or an import);
 * - `filed`: the record was filed into the space `spaceId` (SDK 1.2);
 * - `deal.linked`: the company or person became a party of the deal
 *   `dealId` (SDK 1.2);
 * - `identity.added`: a domain or an email `value` was added to the company
 *   or person after its birth, never by a seed or an import.
 * - `interaction.logged`: the company or person became a participant of the
 *   meeting or call `interactionId` — a synced meeting, or a recorder's
 *   payload (SDK 1.5).
 */
export type DomainEvent =
  | (DomainEventBase & { readonly name: 'entity.created' })
  | (DomainEventBase & { readonly name: 'filed'; readonly spaceId: EntityId })
  | (DomainEventBase & {
      readonly name: 'deal.linked'
      readonly kind: 'company' | 'person'
      readonly dealId: EntityId
    })
  | (DomainEventBase & {
      readonly name: 'identity.added'
      readonly kind: 'company' | 'person'
      readonly key: 'domain' | 'email'
      readonly value: string
    })
  | (DomainEventBase & {
      readonly name: 'interaction.logged'
      readonly kind: 'company' | 'person'
      readonly interactionId: string
      readonly interactionKind: 'meeting' | 'call'
    })

/**
 * `action` — the "Enrich" button; one record. `keys` (SDK 1.3) is what the
 * host's enrichment run still wants from this source, in the vocabulary:
 * absent when the button was pressed on the source itself, and then the
 * source answers everything it knows.
 */
export type ActionInput = {
  readonly entityId: EntityId
  readonly keys?: ReadonlyArray<string>
}
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

/**
 * `schedule` — Gmail, Calendar: resume from the cursor, hand back the next.
 * - `connectedAt` (SDK 1.5) is the forward-only floor: the bound
 *   connection's `created_at`, else the integration's. A syncer fetches
 *   nothing older.
 */
export type ScheduleInput = {
  readonly cursor: string | null
  readonly connectedAt?: IsoTimestamp
}
export type ScheduleOutput = { readonly nextCursor: string | null }

/**
 * A schedule job's cursor is no longer valid — an expired sync token. The
 * host clears the stored cursor and records the run; the next run starts as
 * the first did, from `connectedAt`, never from the beginning of history.
 * (SDK 1.5)
 */
export class CursorInvalid extends Schema.TaggedError<CursorInvalid>()(
  'CursorInvalid',
  { reason: Schema.String },
) {}

/**
 * The provider refused the bound connection's grant — a 401, a revoked
 * token. The host marks the connection `error` with this reason, which the
 * account page shows beside Reconnect, and fails the run without a retry:
 * retrying sends the same refused token. (SDK 1.5)
 */
export class ConnectionRefused extends Schema.TaggedError<ConnectionRefused>()(
  'ConnectionRefused',
  { reason: Schema.String },
) {}

export type ScheduleJob<TServices = unknown> = (
  input: ScheduleInput,
) => Effect.Effect<
  ScheduleOutput,
  JobError | CursorInvalid | ConnectionRefused,
  TServices
>

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

/**
 * `file` — an importer: a dialect export, a WhatsApp export. A dialect hands
 * core a grid through `Import`; anything else speaks claims (D39 as amended).
 */
export type FileInput = {
  readonly stream: ReadableStream<Uint8Array>
  readonly filename: string
  readonly mime: string | null
}
export type FileJob<TServices = unknown> = (
  input: FileInput,
) => Effect.Effect<void, JobError, TServices>

/**
 * `watch` — a saved research lens on a space, run once per `space_watch` row
 * (D72): on its cadence, or on "Run now".
 * - `settings` is the row's, as the job's own `settings` schema took them —
 *   `watchSettingsOf` is the typed read.
 * - `state` is the cursor the last successful run handed back; null before
 *   the first. A run that fails leaves it as it was.
 * - The brief is not handed over: a job asks `Spaces.brief(spaceId)`.
 */
export type WatchInput = {
  readonly watchId: string
  readonly spaceId: EntityId
  readonly settings: JsonObject
  readonly state: JsonObject | null
}
/** The plugin's cursor for the next run — its own, and nothing of the host's. */
export type WatchOutput = { readonly state: JsonObject | null }
export type WatchJob<TServices = unknown> = (
  input: WatchInput,
) => Effect.Effect<WatchOutput, JobError, TServices>

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
          : TTrigger extends 'watch'
            ? WatchJob<TServices>
            : never
