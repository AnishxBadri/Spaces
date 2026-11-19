import { Schema } from 'effect'
import { int } from '@spaces/core/attributes/registry'

/**
 * `setAiCaps`'s input, client-safe: the server-fn validator is evaluated in
 * the client bundle too, so this module imports nothing server-side. A null
 * ceiling is no cap on that axis — the Caps section sends one for a blank
 * field.
 */
const ceiling = Schema.Number.check(int, Schema.isGreaterThan(0))

export const aiCapsInput = Schema.Struct({
  dailyTokens: Schema.NullOr(ceiling),
  perRunTokens: Schema.NullOr(ceiling),
})
export type AiCapsInput = typeof aiCapsInput.Type
