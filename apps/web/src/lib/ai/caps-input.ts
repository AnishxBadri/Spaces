import { z } from 'zod'

/**
 * `setAiCaps`'s input, client-safe: the server-fn validator is evaluated in
 * the client bundle too, so this module imports nothing server-side. A null
 * ceiling is no cap on that axis — the Caps section sends one for a blank
 * field.
 */
const ceiling = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const aiCapsInput = z.object({
  dailyTokens: ceiling.nullable(),
  perRunTokens: ceiling.nullable(),
})
export type AiCapsInput = z.infer<typeof aiCapsInput>
