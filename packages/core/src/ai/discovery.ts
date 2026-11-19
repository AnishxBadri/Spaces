import { Schema } from 'effect'
import { list, nullable, object, readFirst, text } from './decode'

/**
 * The two discovery cards a space's watch hands back: `add_record`
 * for a company nobody holds, `file_record` for one held elsewhere.
 * - `spaceId` and `domain` are the card's identity: one open card per pair,
 *   and a dismissal of the pair refuses every later card for it.
 * - `domain` is stored normalized (`normalizeDomain`): the propose path
 *   rewrites it before the row is written.
 * - `watchIds` are the watches that found it: a later find merges its
 *   evidence and its watch into the open card ("found by 2 watches").
 *
 * One decoder, three readers: the propose path holds a new row to it, the
 * accept path reads it back, and the Review card draws it.
 */

/** What one card holds at most; a merge keeps the first ones. */
export const MAX_EVIDENCE = 50
export const MAX_WATCHES = 50

const evidenceSchema = object(
  {
    url: text({ format: 'url', max: 2000 }),
    title: Schema.optional(text({ trim: true, min: 1, max: 500 })),
  },
  { strict: true },
)

const uuid = text({ format: 'uuid' })

const common = {
  spaceId: uuid,
  domain: text({ trim: true, min: 1, max: 253 }),
  name: text({ trim: true, min: 1, max: 300 }),
  evidence: list(evidenceSchema, { max: MAX_EVIDENCE }),
  watchIds: list(uuid, { max: MAX_WATCHES, fallback: () => [] }),
}

export const addRecordPayloadSchema = object(
  {
    ...common,
    aliases: list(text({ trim: true, min: 1, max: 300 }), { max: 20 }),
    /** A subspace's name or slug under `spaceId`; ignored when none matches. */
    subspaceHint: nullable(text({ trim: true, min: 1, max: 300 })),
  },
  { strict: true },
)

export const fileRecordPayloadSchema = object(
  {
    ...common,
    /** The record held elsewhere, to be filed in `spaceId`. */
    entityId: uuid,
  },
  { strict: true },
)

/** Spelled out rather than the schema's type: an absent key is absent, so JSON by type. */
export type DiscoveryEvidence = { url: string; title?: string }

export type AddRecordPayload = {
  spaceId: string
  domain: string
  name: string
  evidence: Array<DiscoveryEvidence>
  watchIds: Array<string>
  aliases: Array<string>
  subspaceHint: string | null
}

export type FileRecordPayload = {
  spaceId: string
  domain: string
  name: string
  evidence: Array<DiscoveryEvidence>
  watchIds: Array<string>
  entityId: string
}

export const evidenceOf = (
  rows: ReadonlyArray<{ url: string; title?: string | undefined }>,
): Array<DiscoveryEvidence> =>
  rows.map((e) =>
    e.title === undefined ? { url: e.url } : { url: e.url, title: e.title },
  )

/** A stored payload read as an `add_record` card, or null when it is not one. */
export function readAddRecordPayload(raw: unknown): AddRecordPayload | null {
  const parsed = readFirst(addRecordPayloadSchema, raw)
  if (!parsed.success) return null
  return { ...parsed.data, evidence: evidenceOf(parsed.data.evidence) }
}

/** A stored payload read as a `file_record` card, or null when it is not one. */
export function readFileRecordPayload(raw: unknown): FileRecordPayload | null {
  const parsed = readFirst(fileRecordPayloadSchema, raw)
  if (!parsed.success) return null
  return { ...parsed.data, evidence: evidenceOf(parsed.data.evidence) }
}

/** The space a discovery payload is about, or null for any other payload. */
export function discoverySpaceOf(raw: unknown): string | null {
  return (
    (readAddRecordPayload(raw) ?? readFileRecordPayload(raw))?.spaceId ?? null
  )
}
