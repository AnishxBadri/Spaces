import { createServerFn } from '@tanstack/react-start'
import { requireUser } from './shared'

export type {
  BrokenConnection,
  MovingSignal,
  ReviewGroup,
  TodayAttention,
} from '../today/attention'

/**
 * Today's own reads: Review grouped by source and space, the reader's broken
 * connections, and What's moving on the reader's companies. (D79)
 * The program is imported inside the handler so its database code never
 * reaches the client bundle.
 */
export const getTodayAttention = createServerFn().handler(async () => {
  const user = await requireUser()
  const { todayAttentionProgram } = await import('../today/attention')
  const { effectFn } = await import('./effect')
  return effectFn(todayAttentionProgram)(user.id, new Date())
})

/** Live companies: none means Today is the three ways in. (D80) */
export const countCompanies = createServerFn().handler(async () => {
  await requireUser()
  const { companyCountProgram } = await import('../integrations/setup-status')
  const { effectFn } = await import('./effect')
  return effectFn(companyCountProgram)()
})
