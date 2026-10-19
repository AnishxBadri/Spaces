import { Cause, Effect, Exit, Layer } from 'effect'
import type { JsonObject } from '@spaces/sdk'
import {
  ContentTest,
  HttpFetchTest,
  LogTest,
  SecretsTest,
  makeFakeGranolaApi,
} from '@spaces/sdk/testing'
import type { FakeGranolaApi } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.ts'

/**
 * The sync job against the in-repo fake of Granola's notes API: no network,
 * no database. The fake member's notes sit in Deals, Portfolio and Personal,
 * laid out around `NOW`; the member ticked what each test says.
 */
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const TICKED: JsonObject = { folder_ids: ['fld_deals', 'fld_portfolio'] }

const harness = (api: FakeGranolaApi = makeFakeGranolaApi({ now: NOW })) => {
  const content = ContentTest()
  const log = LogTest()
  const layer = Layer.mergeAll(
    HttpFetchTest(api.fetch).layer,
    SecretsTest({ accessToken: api.accessToken }).layer,
    content.layer,
    log.layer,
  )
  const run = (cursor: string | null, settings: JsonObject = TICKED) =>
    Effect.runPromiseExit(
      plugin.jobs
        .sync({ cursor, connection: { settings } })
        .pipe(Effect.provide(layer)),
    )
  const ok = async (cursor: string | null, settings?: JsonObject) => {
    const exit = await run(cursor, settings)
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    return exit.value.nextCursor
  }
  /** What the job handed over, from call `from` on. */
  const handed = (from = 0) => content.calls.slice(from).map((c) => c.input)
  return { api, content, log, run, ok, handed }
}

const paths = (api: FakeGranolaApi) =>
  api.requests.map((r) =>
    r.query.folder_id === undefined ? r.path : `${r.path}?${r.query.folder_id}`,
  )

describe('a member who ticked Deals and Portfolio', () => {
  it('hands over the two notes in those folders, and never asks for the 1:1 in Personal', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    expect(h.handed()).toMatchSnapshot()
    expect(paths(h.api)).toEqual(['/notes?fld_deals', '/notes?fld_portfolio'])
    expect(h.api.requests.some((r) => r.url.includes('personal'))).toBe(false)
    expect(cursor).not.toBeNull()
    expect(JSON.parse(cursor ?? '{}')).toEqual({
      held: {
        not_acme_board: expect.any(String),
        not_flent_first: expect.any(String),
      },
    })
  })

  it('hands nothing twice: an unchanged note is skipped on the next run', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    const from = h.content.calls.length
    expect(await h.ok(cursor)).toBe(cursor)
    expect(h.handed(from)).toEqual([])
  })

  it('hands back a note moved out of every ticked folder, and one Granola deleted', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    const from = h.content.calls.length
    h.api.move('not_flent_first', ['fld_personal'])
    h.api.remove('not_acme_board')
    const next = await h.ok(cursor)
    expect(h.handed(from)).toEqual([
      { _tag: 'recorded-note-gone', providerNoteId: 'not_acme_board' },
      { _tag: 'recorded-note-gone', providerNoteId: 'not_flent_first' },
    ])
    expect(JSON.parse(next ?? '{}')).toEqual({ held: {} })
  })

  it('hands back what an unticked folder held', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    const from = h.content.calls.length
    await h.ok(cursor, { folder_ids: ['fld_deals'] })
    expect(h.handed(from)).toEqual([
      { _tag: 'recorded-note-gone', providerNoteId: 'not_acme_board' },
    ])
  })

  it('picks up a note once Granola has finished processing it', async () => {
    const h = harness()
    const cursor = await h.ok(null)
    const from = h.content.calls.length
    h.api.finish('not_deals_processing')
    await h.ok(cursor)
    expect(h.handed(from)).toMatchObject([
      { _tag: 'recorded-note', providerNoteId: 'not_deals_processing' },
    ])
  })
})

describe('the private extras', () => {
  it('are neither fetched nor handed over until the member opts in', async () => {
    const h = harness()
    await h.ok(null)
    expect(h.api.requests.every((r) => r.path === '/notes')).toBe(true)
    for (const note of h.handed()) expect(note).not.toHaveProperty('typedNotes')
  })

  it('come from the note itself once opted in, and never go into the receipt', async () => {
    const h = harness()
    await h.ok(null, {
      folder_ids: ['fld_deals'],
      typed_notes: true,
      transcript: true,
    })
    expect(paths(h.api)).toEqual(['/notes?fld_deals', '/notes/not_flent_first'])
    expect(h.api.requests.at(1)?.query.include).toBe('transcript')
    const [flent] = h.handed()
    expect(flent).toMatchObject({
      typedNotes: 'Strong founder. Check the churn number.',
      transcript:
        'Maya Rao: We are raising four million.\nAnish: Send the data room.',
    })
    expect(JSON.stringify(flent)).toMatch(/churn/)
    const raw =
      typeof flent === 'object' && flent !== null && 'raw' in flent
        ? flent.raw
        : null
    expect(raw).not.toBeNull()
    expect(JSON.stringify(raw)).not.toMatch(/churn|four million/)
  })
})

describe('a key Granola refuses', () => {
  it('is ConnectionRefused, which marks only this member', async () => {
    const h = harness()
    h.api.revoke()
    const exit = await h.run(null)
    expect(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : null,
    ).toMatchObject({ _tag: 'ConnectionRefused' })
  })

  it('a run with no connection is refused: Granola is per member', async () => {
    const h = harness()
    const exit = await Effect.runPromiseExit(
      plugin.jobs
        .sync({ cursor: null })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              HttpFetchTest(h.api.fetch).layer,
              SecretsTest({ accessToken: h.api.accessToken }).layer,
              h.content.layer,
              h.log.layer,
            ),
          ),
        ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.api.requests).toEqual([])
  })
})
