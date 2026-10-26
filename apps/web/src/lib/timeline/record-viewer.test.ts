import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * The thread row's two facts about its viewer, read by the timeline: which
 * participant is the viewer's own person record (never listed among a
 * row's people) and which email the viewer sent (`To <name>`), with the
 * mailbox thread each row belongs to. Dynamic imports: the harness points
 * `DATABASE_URL` at this worker's database before `@spaces/db` loads.
 */
describe('the record timeline, read by its viewer', () => {
  it('marks the viewer among the people, the emails they sent, and each thread', async () => {
    const { db } = await import('@spaces/db')
    const { interaction, interactionEntity } = await import('@spaces/db/schema')
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { recordTimelineProgram } = await import('./record')

    const born = async (
      kind: 'company' | 'person',
      name: string,
      keys: { domain: string } | { email: string },
    ) =>
      (
        await resolveEntity({
          kind,
          name,
          keys,
          source: { class: 'manual' },
        })
      ).entityId
    const acme = await born('company', 'Viewer Acme', {
      domain: 'viewer-acme.example',
    })
    const me = await born('person', 'Fixture Me', {
      email: FIXTURE_ACTOR.email,
    })
    const ada = await born('person', 'Ada Viewer', {
      email: 'ada@viewer-acme.example',
    })

    const email = async (id: string, from: string, at: string) => {
      const row = (
        await db
          .insert(interaction)
          .values({
            kind: 'email',
            subject: id,
            threadId: 'viewer-thread',
            occurredAt: new Date(at),
            meta: {
              kind: 'email',
              from,
              to: [],
              cc: [],
              date: at,
              mime_blob_sha: null,
            },
          })
          .returning({ id: interaction.id })
      ).at(0)
      if (!row) throw new Error('no interaction')
      await db.insert(interactionEntity).values(
        [acme, me, ada].map((entityId) => ({
          interactionId: row.id,
          entityId,
        })),
      )
    }
    await email(
      'sent by me',
      `Fixture <${FIXTURE_ACTOR.email.toUpperCase()}>`,
      '2026-10-02T10:00:00.000Z',
    )
    await email(
      'from ada',
      'ada@viewer-acme.example',
      '2026-10-01T10:00:00.000Z',
    )

    const items = await Effect.runPromise(
      recordTimelineProgram(acme, FIXTURE_ACTOR),
    )
    const rows = items.flatMap((i) => (i.type === 'interaction' ? [i] : []))
    const sent = rows.find((r) => r.subject === 'sent by me')
    const received = rows.find((r) => r.subject === 'from ada')
    expect(sent?.sent).toBe(true)
    expect(received?.sent).toBe(false)
    expect(sent?.threadId).toBe('viewer-thread')
    expect(
      [...(sent?.attendees ?? [])]
        .map((a) => [a.name, a.self])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual([
      ['Ada Viewer', false],
      ['Fixture Me', true],
    ])
  })
})
