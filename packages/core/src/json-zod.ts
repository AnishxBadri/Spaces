import { z } from 'zod'
import type { Json } from '@spaces/db/json'

/**
 * The zod twin of `jsonValue`, for the zod shapes that still compose it: a
 * plugin port's recorder and call payloads, the vault's `meta`, the MCP
 * propose tool's `patch` (whose JSON schema MCP clients read) and the
 * worker's watch state. It goes with the last of them; anything new decodes
 * with `jsonValue`.
 */
export const jsonValueZod: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueZod),
    z.record(z.string(), jsonValueZod),
  ]),
)
