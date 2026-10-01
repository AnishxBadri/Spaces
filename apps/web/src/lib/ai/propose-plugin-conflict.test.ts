import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * The loop sdk-10 closes, end to end through the inbox's existing accept
 * path (SPA-204): a plugin's `Facts.fill` refuses a value a person holds and
 * raises it as one suggestion; the inbox shows it once however often the
 * job re-runs; a person accepting it writes the value as themselves,
 * `source 'suggestion'`, citing the suggestion and the receipt the plugin
 * stored. The port side is `packages/core/src/writes/ports/judgment.test.ts`;
 * this file proves the accept half, which stays in apps/web. Dynamic imports,
 * as the other DB-backed tests here do: the harness points `DATABASE_URL` at
 * this worker's database before `@spaces/db` loads.
 */
describe('a Facts.fill conflict, accepted from the inbox', () => {
  it('raises one suggestion, stays one on a re-run, and accepts as a user write citing the receipt', async () => {
    const { db } = await import('@spaces/db')
    const { attributeEvent, entity, integration, suggestion } =
      await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { and, eq } = await import('drizzle-orm')
    const { Facts, Receipts } = await import('@spaces/sdk')
    const { Enqueue } = await import('@spaces/core/queue/enqueue')
    const { FactsLive } = await import('@spaces/core/writes/ports/facts')
    const { ReceiptsLive } = await import('@spaces/core/writes/ports/receipts')
    const { setValues } = await import('@spaces/core/writes/attributes/values')
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { acceptProgram } = await import('./propose')
    const { listInboxProgram } = await import('#/lib/inbox/queue')
    const { recordTimelineProgram } = await import('#/lib/timeline/record')

    const person = (
      await db.select({ id: user.id, name: user.name }).from(user).limit(1)
    ).at(0)
    if (!person) throw new Error('the test seed has no user')
    const row = (
      await db
        .insert(integration)
        .values({ capabilityId: 'echo', version: '1.0.0', enabled: true })
        .returning()
    ).at(0)
    if (!row) throw new Error('no integration row')
    const { entityId } = await resolveEntity({
      kind: 'company',
      name: 'Headcount Co',
      keys: { domain: 'headcount-co.example' },
      source: { class: 'manual' },
    })
    // Set by hand: the value a plugin may never overwrite.
    await setValues({
      entityId,
      patch: { founded_year: 1990 },
      actor: { type: 'user', id: person.id },
    })

    const ports = Layer.mergeAll(
      FactsLive(row).pipe(
        Layer.provide(
          Layer.succeed(
            Enqueue,
            Enqueue.of({ enqueue: () => Effect.succeed(null) }),
          ),
        ),
      ),
      ReceiptsLive(row),
    )
    const runJob = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { receiptId } = yield* (yield* Receipts).store({
            entityId,
            raw: { founded_year: 2015 },
          })
          const filled = yield* (yield* Facts).fill({
            entityId,
            values: { founded_year: 2015 },
            receiptId,
          })
          return { receiptId, filled }
        }).pipe(Effect.provide(ports)),
      )

    const first = await runJob()
    expect(first.filled.conflicts).toEqual([
      { slug: 'founded_year', existing: 1990, proposed: 2015 },
    ])
    await runJob()

    // One card, one suggestion, naming both values.
    const inbox = await Effect.runPromise(
      listInboxProgram({ record: entityId }),
    )
    const cards = inbox.filter((r) => r.kind === 'suggestion')
    expect(cards).toHaveLength(1)
    const items = cards.flatMap((c) => c.suggestions)
    expect(items).toHaveLength(1)
    const item = items.at(0)
    if (!item) throw new Error('no suggestion in the inbox')
    expect(item.rationale).toBe(
      'founded_year: echo says 2015; the record holds 1990',
    )
    expect(item.fields?.map((f) => [f.slug, f.value])).toEqual([
      ['founded_year', 2015],
    ])
    expect(
      (
        await db
          .select({ values: entity.values })
          .from(entity)
          .where(eq(entity.id, entityId))
      ).at(0)?.values.founded_year,
    ).toBe(1990)

    // Accepted through the inbox's own accept path.
    const accepted = await Effect.runPromise(
      acceptProgram(item.id, { type: 'user', id: person.id }),
    )
    expect(accepted.suggestion.status).toBe('accepted')

    const written = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, entityId),
          eq(attributeEvent.source, 'suggestion'),
        ),
      )
    expect(written).toHaveLength(1)
    expect(written.at(0)).toMatchObject({
      attrSlug: 'founded_year',
      actorType: 'user',
      actorId: person.id,
      actorRef: null,
      source: 'suggestion',
      suggestionId: item.id,
      from: 1990,
      to: 2015,
      refs: [`event:${first.receiptId}`],
    })
    expect(
      (
        await db
          .select({ status: suggestion.status })
          .from(suggestion)
          .where(eq(suggestion.entityId, entityId))
      ).map((s) => s.status),
    ).toEqual(['accepted'])

    // The timeline: a person's write, through the suggestion door, citing
    // the plugin's receipt.
    const timeline = await Effect.runPromise(recordTimelineProgram(entityId))
    const burst = timeline.find(
      (i) => i.type === 'attrs' && i.source === 'suggestion',
    )
    expect(burst).toMatchObject({
      type: 'attrs',
      actorType: 'user',
      actorName: person.name,
      changes: [
        {
          slug: 'founded_year',
          to: 2015,
          citations: [{ ref: `event:${first.receiptId}` }],
        },
      ],
    })
  })
})
