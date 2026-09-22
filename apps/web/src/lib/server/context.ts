import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * The context read protocol's first product surface (SPA-18): what the
 * assembler sees for one record, as the requesting user may see it. The
 * clock and the budget are stamped here, at the boundary, so the program
 * underneath stays deterministic on (data, asOf, user). The assembler's
 * tagged failures — ContextQueryFailed, ContextEntityNotFound, ContextLeak —
 * reject through `effectFn()` and the normal server-fn error path.
 */

const DEFAULT_BUDGET_CHARS = 8000

export const getRecordContext = createServerFn()
  .validator(
    z.object({
      entityId: z.string().uuid(),
      budgetChars: z.number().int().min(500).max(100_000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { recordContextProgram } = await import('../context/record')
    const { effectFn } = await import('./effect')
    return effectFn(recordContextProgram)({
      entityId: data.entityId,
      user: { id: u.id },
      asOf: new Date().toISOString(),
      budgetChars: data.budgetChars ?? DEFAULT_BUDGET_CHARS,
    })
  })
