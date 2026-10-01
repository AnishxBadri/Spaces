import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

/**
 * The context read protocol's first product surface (SPA-18): what the
 * assembler sees for one record, as the requesting user may see it. The
 * clock and the budget are stamped here, at the boundary, so the program
 * underneath stays deterministic on (data, asOf, user). The assembler's
 * tagged failures — ContextQueryFailed, ContextEntityNotFound, ContextLeak —
 * reject through `effectFn()` and the normal server-fn error path.
 */

export const getRecordContext = createServerFn()
  .validator(
    z.object({
      entityId: z.string().uuid(),
      budgetChars: z.number().int().min(500).max(100_000).optional(),
      /** The judgment-memory mode (SPA-139); off unless the readout asks. */
      similar: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    // The body is `getRecordContextHandler` (lib/ai/record-context-handler.ts),
    // shared word for word with the MCP `get_context` tool's test (SPA-23).
    const { getRecordContextHandler } =
      await import('../ai/record-context-handler')
    return getRecordContextHandler(data)
  })
