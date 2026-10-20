import { z } from 'zod'
import type { Json } from '@spaces/db/json'
import type {
  InteractionKind,
  InteractionMeta,
} from '@spaces/db/schema/interactions'

/**
 * The closed JSON type every `jsonb()` column is typed against. It is
 * declared at the columns that claim it — `@spaces/db/json` — and re-exported
 * here so the app's `@spaces/core/json` imports (until SPA-176, `#/lib/json`)
 * read the same name they always did (SPA-142).
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
 * The same shape as a decoder, for the one place stored JSON arrives from
 * the client (a note body) and has to be parsed rather than trusted.
 */
export const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
)

const rsvp = z.enum(['accepted', 'declined', 'tentative', 'needs_action'])

const emailMeta = z
  .object({
    kind: z.literal('email'),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()).exactOptional(),
    date: z.string(),
    mime_blob_sha: z.string().nullable(),
    labels: z.array(z.string()).exactOptional(),
    snippet: z.string().exactOptional(),
    summary: z.string().exactOptional(),
    categories: z.array(z.string()).exactOptional(),
  })
  .strict()

const recorderEvent = z
  .object({
    provider_event_id: z.string(),
    receipt_id: z.string(),
    web_url: z.string().exactOptional(),
  })
  .strict()

const meetingMeta = z
  .object({
    kind: z.literal('meeting'),
    ends_at: z.string(),
    status: z.enum(['scheduled', 'cancelled']),
    conference_url: z.string().nullable(),
    organizer: z.string().nullable(),
    recurring_instance_id: z.string().nullable(),
    rsvp: z.record(z.string(), rsvp),
    calendar_event_id: z.string().exactOptional(),
    recorder_events: z.array(recorderEvent).exactOptional(),
  })
  .strict()

const callMeta = z
  .object({
    kind: z.literal('call'),
    provider_event_id: z.string(),
    duration_seconds: z.number().int().nonnegative().nullable(),
    receipt_id: z.string().exactOptional(),
    web_url: z.string().exactOptional(),
  })
  .strict()

/** The decoder of `interaction.meta`: one shape per interaction kind. */
export const interactionMetaSchema: z.ZodType<InteractionMeta> =
  z.discriminatedUnion('kind', [emailMeta, meetingMeta, callMeta])

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
  const parsed = interactionMetaSchema.safeParse(raw)
  if (!parsed.success)
    return {
      ok: false,
      reason: parsed.error.issues
        .map((i) => `${i.path.map(String).join('.') || 'meta'}: ${i.message}`)
        .join('; '),
    }
  if (parsed.data.kind !== rowKind)
    return {
      ok: false,
      reason: `meta is a ${parsed.data.kind} shape; the row is ${rowKind}`,
    }
  return { ok: true, meta: parsed.data }
}

/** A recorder connection's choices (D78): the ticked folders and two opt-ins. */
export type RecorderSettings = {
  folderIds: Array<string>
  /** Fetch the member's typed notes, private to them. */
  typedNotes: boolean
  /** Fetch the transcript, private to them. */
  transcript: boolean
}

const recorderSettings = z.object({
  folder_ids: z.array(z.string().min(1)).catch([]),
  typed_notes: z.boolean().catch(false),
  transcript: z.boolean().catch(false),
})

/**
 * `account_connection.settings` read as a recorder's: nothing ticked and
 * both opt-ins off until the person chooses, and a malformed key reads as
 * its default rather than failing the page.
 */
export function readRecorderSettings(raw: Json): RecorderSettings {
  const parsed = recorderSettings.parse(jsonRecord(raw))
  return {
    folderIds: [...new Set(parsed.folder_ids)],
    typedNotes: parsed.typed_notes,
    transcript: parsed.transcript,
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

/** One recipient chip on an `email_draft`, as the composer sends it. (D67) */
const draftRecipientSchema = z
  .object({
    email: z.email().max(320),
    entityId: z.uuid().exactOptional(),
    name: z.string().max(400).exactOptional(),
  })
  .strict()

/** A draft's recipients: one line of chips, at most 100. */
export const draftRecipientsSchema = z.array(draftRecipientSchema).max(100)

/** A draft's attachments: the documents it carries, at most 50. */
export const draftAttachmentsSchema = z
  .array(z.object({ documentId: z.uuid() }).strict())
  .max(50)
