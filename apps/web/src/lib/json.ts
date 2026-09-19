import { z } from 'zod'

/**
 * The closed JSON type every `jsonb()` column is typed against. Stored JSON
 * is data crossing a boundary: it gets its type once, at the column, and no
 * reader re-asserts it. Closed rather than `unknown` because Start's
 * serializer rejects `unknown` at the server-fn seam.
 */
export type Json =
  string | number | boolean | null | Array<Json> | { [k: string]: Json }

/**
 * A stored value read as a string — absent, null, and non-strings all miss.
 * The one narrowing a jsonb reader still needs, in one place instead of
 * twelve `as string | undefined` casts.
 */
export function jsonString(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : null
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
