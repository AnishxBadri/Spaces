import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { requireAdmin, requireSettingsReader, requireUser } from './shared'
import { input } from './input'

export type { DemoSummary } from '../seeds/demo'
export type { SetupAudience } from '../integrations/setup-status'

/**
 * The first run without a checklist: What's set up and the demo's
 * removal on General, and Enrich pressed on a record.
 * The programs they run are imported dynamically, so their database code
 * never reaches the client bundle.
 */

const getSetupStateProgram = Effect.fn('getSetupStateProgram')(function* () {
  const { setupGateProgram } = yield* Effect.promise(
    () => import('../integrations/setup-status'),
  )
  const gate = yield* setupGateProgram()
  if (gate.needsSetup) {
    const { printSetupToken } = yield* Effect.promise(
      () => import('../setup-token'),
    )
    yield* Effect.sync(printSetupToken)
  }
  return gate
})

/**
 * True until the first admin exists — drives the /setup redirect — and the
 * workspace's name after. Public: login reads it before anyone signs in.
 * Asking while setup is needed (re)prints the one-time token to the server
 * logs, so the operator who just opened /setup finds it in the terminal.
 */
export const getSetupState = createServerFn().handler(async () =>
  Effect.runPromise(getSetupStateProgram()),
)

/** General's foot: whether each of the seven pieces is set up. */
export const getWhatsSetUp = createServerFn().handler(async () => {
  await requireSettingsReader()
  const { whatsSetUpProgram } = await import('../integrations/setup-status')
  const { effectFn } = await import('./effect')
  return effectFn(whatsSetUpProgram)()
})

/** The demo still recorded, by kind; null once removed or never loaded. */
export const getDemoSummary = createServerFn().handler(async () => {
  await requireSettingsReader()
  const { demoSummaryProgram } = await import('../seeds/demo')
  const { effectFn } = await import('./effect')
  return effectFn(demoSummaryProgram)()
})

/** Deletes exactly the recorded demo records, then clears the key. Admin. */
export const removeDemoData = createServerFn({ method: 'POST' }).handler(
  async () => {
    await requireAdmin()
    const { removeDemoDataProgram } = await import('../seeds/demo')
    const { effectFn } = await import('./effect')
    return effectFn(removeDemoDataProgram)()
  },
)

const enrichRecordProgram = Effect.fn('enrichRecordProgram')(function* (
  entityId: string,
) {
  const { enqueue } = yield* Effect.promise(() => import('../queue'))
  const { QUEUES } = yield* Effect.promise(
    () => import('@spaces/core/queue/names'),
  )
  const jobId = yield* Effect.promise(() =>
    enqueue(QUEUES.enrichmentRun, { entityId, reason: 'Enrich pressed' }),
  )
  return { queued: jobId !== null }
})

/** Runs the host's enrichment on one record now: `enrichment.run`. Any member. */
export const enrichRecord = createServerFn({ method: 'POST' })
  .validator(
    input(Schema.Struct({ entityId: Schema.String.check(Schema.isUUID()) })),
  )
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(enrichRecordProgram(data.entityId))
  })
