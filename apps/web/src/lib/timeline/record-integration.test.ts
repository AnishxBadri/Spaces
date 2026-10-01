import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * A record a plugin birthed (sdk-7a): IdentityLive writes its
 * `company.created` activity with no user — `actor_id` null, the integration
 * in `meta` (`integrationMeta`, core's one spelling of it; the port side is
 * `packages/core/src/writes/ports/identity.test.ts`) — and the timeline must
 * show that row as the plugin, not as a person and not as "System". Dynamic
 * imports, as the other timeline tests do: the harness points `DATABASE_URL`
 * at this worker's database before `@spaces/db` loads.
 */
describe('the record timeline, for a record a plugin birthed', () => {
  it('names the integration on the birth row', async () => {
    const { db } = await import('@spaces/db')
    const { integration } = await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { integrationMeta } =
      await import('@spaces/core/writes/ports/identity')
    const { recordTimelineProgram } = await import('./record')

    const row = (
      await db
        .insert(integration)
        .values({ capabilityId: 'apollo', version: '1.0.0', enabled: true })
        .returning()
    ).at(0)
    if (!row) throw new Error('no row')
    const { entityId } = await resolveEntity({
      kind: 'company',
      name: 'Timeline Plugin Co',
      keys: { domain: 'timeline-plugin.example' },
      source: { class: 'integration', ref: row.id },
    })
    await db.insert(activity).values({
      actorId: null,
      verb: 'company.created',
      subjectEntityId: entityId,
      meta: integrationMeta(row),
    })

    const items = await Effect.runPromise(recordTimelineProgram(entityId))
    const birth = items.find(
      (i) => i.type === 'macro' && i.verb === 'company.created',
    )
    expect(birth).toMatchObject({ type: 'macro', actorName: 'apollo' })
  })
})
