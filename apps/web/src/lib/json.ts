import { z } from 'zod'
import type { Json } from '@spaces/db/json'

/**
 * The closed JSON type every `jsonb()` column is typed against. It is
 * declared at the columns that claim it — `@spaces/db/json` — and re-exported
 * here so the app's hundred-odd `#/lib/json` imports read the same name they
 * always did (SPA-142).
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
