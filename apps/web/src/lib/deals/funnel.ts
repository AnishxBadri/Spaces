import { Effect, Schema } from 'effect'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attributeEvent, entity } from '@spaces/db/schema'

/**
 * Funnel stats over the stage change log (`attribute_event`, slug `stage`):
 * nothing stored, everything derived.
 * - A deal entered its stage at the newest event whose `to` is its current
 *   stage; a deal with no such event has no days and is left out of medians.
 * - `medianDaysInStage` is the median over the live deals in each stage —
 *   Today's "Idle in stage" tick and the deal page's Days in stage readout.
 *
 * Outside the server-fn barrel so tests and other loaders can call it.
 */
export type StageFunnel = {
  countByStage: Record<string, number>
  medianDaysInStage: Record<string, number>
  daysInStage: Array<{
    id: string
    name: string
    stage: string
    days: number | null
  }>
}

export class StageFunnelFailed extends Schema.TaggedError<StageFunnelFailed>()(
  'StageFunnelFailed',
  { cause: Schema.Defect() },
) {}

export const stageFunnelProgram = Effect.fn('stageFunnelProgram')(function* (
  now: number,
): Effect.fn.Return<StageFunnel, StageFunnelFailed> {
  const { deals, events } = yield* Effect.tryPromise({
    try: async () => {
      const live = await db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          values: entity.values,
        })
        .from(entity)
        .where(and(eq(entity.kind, 'deal'), isNull(entity.mergedIntoId)))
      const stageEvents =
        live.length === 0
          ? []
          : await db
              .select({
                entityId: attributeEvent.entityId,
                to: attributeEvent.to,
                at: attributeEvent.at,
              })
              .from(attributeEvent)
              .where(
                and(
                  eq(attributeEvent.attrSlug, 'stage'),
                  inArray(
                    attributeEvent.entityId,
                    live.map((d) => d.id),
                  ),
                ),
              )
              .orderBy(desc(attributeEvent.at))
      return { deals: live, events: stageEvents }
    },
    catch: (cause) => new StageFunnelFailed({ cause }),
  })

  // Events are newest-first, so the first hit is the latest entry.
  const enteredAt = new Map<string, number>()
  for (const d of deals) {
    const stage = d.values.stage ?? null
    const hit = events.find((e) => e.entityId === d.id && e.to === stage)
    if (hit) enteredAt.set(d.id, hit.at.getTime())
  }

  const daysByStage = new Map<string, Array<number>>()
  const countByStage = new Map<string, number>()
  for (const d of deals) {
    const stage = String(d.values.stage ?? '')
    if (!stage) continue
    countByStage.set(stage, (countByStage.get(stage) ?? 0) + 1)
    const entered = enteredAt.get(d.id)
    if (entered !== undefined) {
      const list = daysByStage.get(stage) ?? []
      list.push((now - entered) / 86_400_000)
      daysByStage.set(stage, list)
    }
  }

  const medianDays: Record<string, number> = {}
  for (const [stage, days] of daysByStage) {
    const sorted = [...days].sort((a, b) => a - b)
    medianDays[stage] = sorted[Math.floor(sorted.length / 2)]
  }

  const daysInStage = deals
    .map((d) => {
      const entered = enteredAt.get(d.id)
      return {
        id: d.id,
        name: d.name,
        stage: String(d.values.stage ?? ''),
        days: entered === undefined ? null : (now - entered) / 86_400_000,
      }
    })
    .filter((d) => d.stage)

  return {
    countByStage: Object.fromEntries(countByStage),
    medianDaysInStage: medianDays,
    daysInStage,
  }
})
