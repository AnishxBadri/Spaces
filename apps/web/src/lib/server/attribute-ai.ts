import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireAdmin, requireUser } from './shared'

/**
 * AI attribute cells (SPA-72). A cell's trigger — on the record rail or in
 * the table, only where the attribute carries `options.ai` (the spec's
 * `attribute.config.ai`) — presses `runAttributeCell`; the cell polls
 * `attributeCellStatus` while its job runs, and a surface reads
 * `openCellProposals` once for the records it shows, to draw "proposed".
 * `addProposedOption` is the inbox card's "Add option" on a registry
 * proposal. The bodies live in `lib/ai/attribute-run.ts`.
 */

const byCell = z.object({
  entityId: z.string().uuid(),
  attributeId: z.string().uuid(),
})

export type {
  AttributeRunEnqueued,
  AttributeRunRefusal,
  AttributeRunStatus,
  OpenCellProposal,
  OptionAdded,
} from '../ai/attribute-run'

export const runAttributeCell = createServerFn({ method: 'POST' })
  .validator(byCell)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { pressAttributeRunProgram } = await import('../ai/attribute-run')
    const { effectFn } = await import('./effect')
    return effectFn(pressAttributeRunProgram)(
      data.entityId,
      data.attributeId,
      u.id,
    )
  })

/** Where the cell's latest run stands — polled while one is running. */
export const attributeCellStatus = createServerFn()
  .validator(byCell)
  .handler(async ({ data }) => {
    await requireUser()
    const { attributeRunStatusProgram } = await import('../ai/attribute-run')
    const { effectFn } = await import('./effect')
    return effectFn(attributeRunStatusProgram)(data.entityId, data.attributeId)
  })

/** Every (record, slug) with an open proposal, for the records on screen. */
export const openCellProposals = createServerFn()
  .validator(z.object({ entityIds: z.array(z.string().uuid()).max(500) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { openCellProposalsProgram } = await import('../ai/attribute-run')
    const { effectFn } = await import('./effect')
    return effectFn(openCellProposalsProgram)(data.entityIds)
  })

export type { ColumnRunEnqueued, ColumnRunEstimate } from '../ai/column-run'

const byColumn = z.object({
  viewId: z.string().uuid(),
  attributeId: z.string().uuid(),
})

/**
 * Column run (SPA-122): what "Run on this view" would do — the view's
 * records counted in SQL over its conditions, the ones already proposed,
 * the rough token cost — or why it is refused. Read when the confirm
 * dialog opens; nothing is queued.
 */
export const estimateColumnRun = createServerFn()
  .validator(byColumn)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { estimateColumnRunProgram } = await import('../ai/column-run')
    const { effectFn } = await import('./effect')
    return effectFn(estimateColumnRunProgram)(
      data.viewId,
      data.attributeId,
      u.id,
    )
  })

/** The dialog's confirm: one `attribute.column-run` job, or the refusal. */
export const runColumn = createServerFn({ method: 'POST' })
  .validator(byColumn)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { pressColumnRunProgram } = await import('../ai/column-run')
    const { effectFn } = await import('./effect')
    return effectFn(pressColumnRunProgram)(data.viewId, data.attributeId, u.id)
  })

/**
 * "Add option" on a registry proposal: the attribute's option-list edit,
 * which is admin-owned (`updateAttribute`), then the proposal accepted.
 */
export const addProposedOption = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      suggestionId: z.string().uuid(),
      label: z.string().trim().min(1).max(60),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireAdmin()
    const { addProposedOptionProgram } = await import('../ai/attribute-run')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(addProposedOptionProgram)(
        data.suggestionId,
        data.label,
        u.id,
      )
    } catch (err) {
      throw new Error(
        err instanceof Error && err.message !== ''
          ? err.message
          : 'Could not add the option',
      )
    }
  })
