import { createServerFn } from '@tanstack/react-start'
import { requireUser } from './shared'

export type {
  BrokenConnection,
  ConnectInvite,
  ExpiringConnection,
  FailingBinding,
  MovingSignal,
  ParkedSource,
  TodayAttention,
  WaitingExport,
} from '../today/attention'

/**
 * Today's own reads: the open Review queue, the reader's broken
 * connections, uploads waiting to write through, and What's moving on the
 * reader's companies.
 * The program is imported inside the handler so its database code never
 * reaches the client bundle.
 */
export const getTodayAttention = createServerFn().handler(async () => {
  const user = await requireUser()
  const { todayAttentionProgram } = await import('../today/attention')
  const { effectFn } = await import('./effect')
  return effectFn(todayAttentionProgram)(user.id, new Date())
})

/** Live companies: none means Today is the three ways in. */
export const countCompanies = createServerFn().handler(async () => {
  await requireUser()
  const { companyCountProgram } = await import('../integrations/setup-status')
  const { effectFn } = await import('./effect')
  return effectFn(companyCountProgram)()
})
