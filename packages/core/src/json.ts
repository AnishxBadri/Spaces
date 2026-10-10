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
    date: z.string(),
    mime_blob_sha: z.string().nullable(),
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
  })
  .strict()

const callMeta = z
  .object({
    kind: z.literal('call'),
    provider_event_id: z.string(),
    duration_seconds: z.number().int().nonnegative().nullable(),
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
