import { z } from 'zod'

/**
 * The two discovery cards a space's watch hands back (D72): `add_record`
 * for a company nobody holds, `file_record` for one held elsewhere.
 * - `spaceId` and `domain` are the card's identity: one open card per pair,
 *   and a dismissal of the pair refuses every later card for it.
 * - `domain` is stored normalized (`normalizeDomain`): the propose path
 *   rewrites it before the row is written.
 * - `watchIds` are the watches that found it: a later find merges its
 *   evidence and its watch into the open card ("found by 2 watches"). (D77)
 *
 * One decoder, three readers: the propose path holds a new row to it, the
 * accept path reads it back, and the Review card draws it.
 */

/** What one card holds at most; a merge keeps the first ones. */
export const MAX_EVIDENCE = 50
export const MAX_WATCHES = 50

const evidenceSchema = z
  .object({
    url: z.string().url().max(2000),
    title: z.string().trim().min(1).max(500).optional(),
  })
  .strict()

const common = {
  spaceId: z.string().uuid(),
  domain: z.string().trim().min(1).max(253),
  name: z.string().trim().min(1).max(300),
  evidence: z.array(evidenceSchema).max(MAX_EVIDENCE),
  watchIds: z.array(z.string().uuid()).max(MAX_WATCHES).default([]),
}

export const addRecordPayloadSchema = z
  .object({
    ...common,
    aliases: z.array(z.string().trim().min(1).max(300)).max(20),
    /** A subspace's name or slug under `spaceId`; ignored when none matches. */
    subspaceHint: z.string().trim().min(1).max(300).nullable(),
  })
  .strict()

export const fileRecordPayloadSchema = z
  .object({
    ...common,
    /** The record held elsewhere, to be filed in `spaceId`. */
    entityId: z.string().uuid(),
  })
  .strict()

/** Spelled out rather than `z.infer`: an absent key is absent, so JSON by type. */
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
  const parsed = addRecordPayloadSchema.safeParse(raw)
  if (!parsed.success) return null
  return { ...parsed.data, evidence: evidenceOf(parsed.data.evidence) }
}

/** A stored payload read as a `file_record` card, or null when it is not one. */
export function readFileRecordPayload(raw: unknown): FileRecordPayload | null {
  const parsed = fileRecordPayloadSchema.safeParse(raw)
  if (!parsed.success) return null
  return { ...parsed.data, evidence: evidenceOf(parsed.data.evidence) }
}

/** The space a discovery payload is about, or null for any other payload. */
export function discoverySpaceOf(raw: unknown): string | null {
  return (
    (readAddRecordPayload(raw) ?? readFileRecordPayload(raw))?.spaceId ?? null
  )
}
