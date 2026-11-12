import {
  Option,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from 'effect'
import {
  decodeValue,
  emailString,
  finite,
  int,
  uuidString,
} from './attributes/registry'
import type { DecodedValue } from './attributes/registry'
import type { Json } from '@spaces/db/json'
import type {
  InteractionKind,
  InteractionMeta,
} from '@spaces/db/schema/interactions'

/**
 * The closed JSON type every `jsonb()` column is typed against. Declared at
 * the columns (`@spaces/db/json`), re-exported so `@spaces/core/json` callers
 * read one name.
 */
export type { Json }

/**
 * A stored value read as a string — absent, null, and non-strings all miss.
 * The one narrowing a jsonb reader still needs, in one place instead of
 * twelve `as string | undefined` casts.
 */
export function jsonString(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : null
}

/** A stored value read as a list of strings — non-strings dropped, anything else empty. */
export function jsonStrings(v: Json | undefined): Array<string> {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : []
}

/** A stored value read as a JSON object — anything else reads as empty. */
export function jsonRecord(v: Json | undefined): { [k: string]: Json } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

/**
 * Zod's plain object: `Object.prototype` or no prototype at all, never a
 * class instance, a date or a map, and no symbol key.
 */
function isPlainJsonObject(u: unknown): u is { readonly [k: string]: unknown } {
  if (typeof u !== 'object' || u === null || Array.isArray(u)) return false
  if (
    Object.getOwnPropertySymbols(u).some((k) =>
      Object.prototype.propertyIsEnumerable.call(u, k),
    )
  )
    return false
  const ctor: unknown = Reflect.get(u, 'constructor')
  if (typeof ctor !== 'function') return true
  const prototype: unknown = Reflect.get(ctor, 'prototype')
  return (
    typeof prototype === 'object' &&
    prototype !== null &&
    Object.prototype.hasOwnProperty.call(prototype, 'isPrototypeOf')
  )
}

/** A plain object, its `__proto__` key dropped rather than copied. */
const plainObject = Schema.declare(isPlainJsonObject).pipe(
  Schema.decode(
    SchemaTransformation.transform({
      decode: (o: { readonly [k: string]: unknown }) =>
        Object.fromEntries(
          Object.entries(o).filter(([k]) => k !== '__proto__'),
        ),
      encode: (o: { readonly [k: string]: unknown }) => o,
    }),
  ),
)

const jsonItem = Schema.suspend((): Schema.Decoder<Json> => jsonValue)

/**
 * The same shape as a decoder, for the places stored JSON arrives from
 * outside (a note body, a webhook, a model's answer) and has to be parsed
 * rather than trusted. Finite numbers only; the decoded value is a copy.
 */
export const jsonValue: Schema.Decoder<Json> = Schema.Union([
  Schema.String,
  Schema.Number.check(finite),
  Schema.Boolean,
  Schema.Null,
  Schema.mutable(Schema.Array(jsonItem)),
  plainObject.pipe(
    Schema.decodeTo(
      Schema.Record(Schema.String, Schema.mutableKey(jsonItem)),
      SchemaTransformation.passthroughSupertype(),
    ),
  ),
])

/** `raw` decoded as JSON: `success` and `data`, or a refusal's message. */
export const readJson = (raw: unknown): DecodedValue<Json> =>
  decodeValue(jsonValue, raw)

/** `raw` as JSON; throws when it is not JSON. */
export const toJson = (raw: unknown): Json =>
  Schema.decodeUnknownSync(jsonValue)(raw)

/** Unknown keys refuse the shape rather than being dropped. */
const strict = { parseOptions: { onExcessProperty: 'error' } } as const

const strings = Schema.mutable(Schema.Array(Schema.String))

const rsvp = Schema.Literals([
  'accepted',
  'declined',
  'tentative',
  'needs_action',
])

const emailMeta = Schema.Struct({
  kind: Schema.Literal('email'),
  from: Schema.String,
  to: strings,
  cc: strings,
  bcc: Schema.optionalKey(strings),
  date: Schema.String,
  mime_blob_sha: Schema.NullOr(Schema.String),
  labels: Schema.optionalKey(strings),
  snippet: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  categories: Schema.optionalKey(strings),
}).annotate(strict)

const recorderEvent = Schema.Struct({
  provider_event_id: Schema.String,
  receipt_id: Schema.String,
  web_url: Schema.optionalKey(Schema.String),
}).annotate(strict)

const meetingMeta = Schema.Struct({
  kind: Schema.Literal('meeting'),
  ends_at: Schema.String,
  status: Schema.Literals(['scheduled', 'cancelled']),
  conference_url: Schema.NullOr(Schema.String),
  organizer: Schema.NullOr(Schema.String),
  recurring_instance_id: Schema.NullOr(Schema.String),
  rsvp: Schema.Record(Schema.String, Schema.mutableKey(rsvp)),
  calendar_event_id: Schema.optionalKey(Schema.String),
  recorder_events: Schema.optionalKey(
    Schema.mutable(Schema.Array(recorderEvent)),
  ),
}).annotate(strict)

const callMeta = Schema.Struct({
  kind: Schema.Literal('call'),
  provider_event_id: Schema.String,
  duration_seconds: Schema.NullOr(
    Schema.Number.check(finite, int, Schema.isGreaterThanOrEqualTo(0)),
  ),
  receipt_id: Schema.optionalKey(Schema.String),
  web_url: Schema.optionalKey(Schema.String),
}).annotate(strict)

/** The decoder of `interaction.meta`: one shape per interaction kind. */
export const interactionMetaSchema: Schema.Decoder<InteractionMeta> =
  Schema.Union([emailMeta, meetingMeta, callMeta])

const metaIssues = SchemaIssue.makeFormatterStandardSchemaV1()

export type InteractionMetaRead =
  { ok: true; meta: InteractionMeta | null } | { ok: false; reason: string }

/**
 * `interaction.meta` read against the row it sits on.
 * - Null reads as null: a lane with no metadata wrote none.
 * - A shape whose `kind` is not the row's is refused, never coerced — a
 *   meeting's RSVPs on an email row are a writer's bug, not data.
 */
export function readInteractionMeta(
  rowKind: InteractionKind,
  raw: Json,
): InteractionMetaRead {
  if (raw === null) return { ok: true, meta: null }
  const parsed = SchemaParser.decodeUnknownResult(interactionMetaSchema, {
    errors: 'all',
  })(raw)
  if (Result.isFailure(parsed))
    return {
      ok: false,
      reason: metaIssues(parsed.failure)
        .issues.map(
          (i) =>
            `${(i.path ?? []).map((s) => String(typeof s === 'object' ? s.key : s)).join('.') || 'meta'}: ${i.message}`,
        )
        .join('; '),
    }
  if (parsed.success.kind !== rowKind)
    return {
      ok: false,
      reason: `meta is a ${parsed.success.kind} shape; the row is ${rowKind}`,
    }
  return { ok: true, meta: parsed.success }
}

/** A recorder connection's choices: the ticked folders and two opt-ins. */
export type RecorderSettings = {
  folderIds: Array<string>
  /** Fetch the member's typed notes, private to them. */
  typedNotes: boolean
  /** Fetch the transcript, private to them. */
  transcript: boolean
}

/** `raw` decoded by `schema`, or `fallback` when it does not decode. */
const orDefault = <T>(
  schema: Schema.Decoder<T>,
  raw: unknown,
  fallback: T,
): T =>
  Option.getOrElse(Schema.decodeUnknownOption(schema)(raw), () => fallback)

const folderIds = Schema.Array(Schema.String.check(Schema.isMinLength(1)))

/**
 * `account_connection.settings` read as a recorder's: nothing ticked and
 * both opt-ins off until the person chooses, and a malformed key reads as
 * its default rather than failing the page.
 */
export function readRecorderSettings(raw: Json): RecorderSettings {
  const stored = jsonRecord(raw)
  return {
    folderIds: [...new Set(orDefault(folderIds, stored.folder_ids, []))],
    typedNotes: orDefault(Schema.Boolean, stored.typed_notes, false),
    transcript: orDefault(Schema.Boolean, stored.transcript, false),
  }
}

/** The stored form `readRecorderSettings` reads, which the plugin is handed. */
export function recorderSettingsJson(settings: RecorderSettings): {
  [k: string]: Json
} {
  return {
    folder_ids: [...new Set(settings.folderIds)],
    typed_notes: settings.typedNotes,
    transcript: settings.transcript,
  }
}

/** One recipient chip on an `email_draft`, as the composer sends it. */
const draftRecipientSchema = Schema.Struct({
  email: emailString.check(Schema.isMaxLength(320)),
  entityId: Schema.optionalKey(uuidString),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
}).annotate(strict)

/** A draft's recipients: one line of chips, at most 100. */
export const draftRecipientsSchema = Schema.mutable(
  Schema.Array(draftRecipientSchema),
).check(Schema.isMaxLength(100))

/** A draft's attachments: the documents it carries, at most 50. */
export const draftAttachmentsSchema = Schema.mutable(
  Schema.Array(Schema.Struct({ documentId: uuidString }).annotate(strict)),
).check(Schema.isMaxLength(50))

/** An `email` template's body: what applying it copies into a draft. */
export type EmailTemplateBody = {
  subject: string
  body_md: string
  attachments: Array<{ documentId: string }>
}

const emailTemplateBodySchema = Schema.Struct({
  subject: Schema.String.check(Schema.isMaxLength(998)),
  body_md: Schema.String.check(Schema.isMaxLength(200_000)),
  attachments: draftAttachmentsSchema,
}).annotate(strict)

/** A stored `email` template body, or null when the row holds another shape. */
export function readEmailTemplateBody(raw: Json): EmailTemplateBody | null {
  return Option.getOrNull(
    Schema.decodeUnknownOption(emailTemplateBodySchema)(raw),
  )
}
