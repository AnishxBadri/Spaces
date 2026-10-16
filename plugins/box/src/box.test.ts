import { Effect, Layer } from 'effect'
import {
  BOX_DOWNLOAD,
  FAKE_BOX_CHAOS_FIXTURE,
  FAKE_BOX_CREDENTIALS,
  FAKE_BOX_FIXTURE,
  FAKE_BOX_SCAN,
  HttpFetchTest,
  SecretsTest,
  makeFakeBoxApi,
  sha256Hex,
  storageSourceChaos,
  storageSourceConformance,
} from '@spaces/sdk/testing'
import type { FakeBoxApi } from '@spaces/sdk/testing'
import type { StorageSource } from '@spaces/sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BOX_NOTE_MIME, boxSource } from './box.ts'

/**
 * The plugin's real HTTP code against the SDK's fake Box: the fake answers
 * Box's content API, events and downloads over a seeded data room, the Http
 * port is a plain fetch over it, and `fetch` itself throws — no request
 * reaches Box.
 */
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the Box tests must not reach the network')
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const portsFor = (api: FakeBoxApi, accessToken = api.accessToken) =>
  Layer.merge(
    HttpFetchTest(api.fetch).layer,
    SecretsTest({ accessToken }).layer,
  )

const subject = (api: FakeBoxApi = makeFakeBoxApi()) => ({
  api,
  source: Effect.runSync(Effect.provide(boxSource, portsFor(api))),
})

const run = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(effect)

/** The typed failure, or null when the effect succeeded. */
const failureOf = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(
    Effect.match(effect, { onFailure: (e) => e, onSuccess: () => null }),
  )

const bytesOf = (stream: ReadableStream<Uint8Array>) =>
  Effect.promise(
    async () => new Uint8Array(await new Response(stream).arrayBuffer()),
  )

const read = (source: StorageSource, fileId: string) =>
  run(
    Effect.gen(function* () {
      const file = yield* source.getFile(fileId)
      const bytes = yield* bytesOf(file.stream)
      return { file, bytes, sha: yield* sha256Hex(bytes) }
    }),
  )

const encoder = new TextEncoder()

describe('the storage-source conformance suite, against the fake Box', () => {
  it.each(
    storageSourceConformance({
      make: () => subject().source,
      fixture: FAKE_BOX_FIXTURE,
      secrets: [
        FAKE_BOX_CREDENTIALS.clientSecret,
        FAKE_BOX_CREDENTIALS.refreshToken,
      ],
    }),
  )('$name', ({ run: conform }) => Effect.runPromise(conform))
})

/**
 * The chaos list over HTTP: 429 with Retry-After, a 404 after a listing,
 * a 400 for a stream position Box no longer holds, a 401 — and the 200 MB
 * scan streamed through the download redirect.
 */
describe('the storage-source chaos suite, against the fake Box', () => {
  it.each(
    storageSourceChaos({
      make: () => {
        const { api, source } = subject(
          makeFakeBoxApi({ largeFiles: [FAKE_BOX_SCAN] }),
        )
        return { source, chaos: api.chaos }
      },
      fixture: FAKE_BOX_CHAOS_FIXTURE,
      secrets: [
        FAKE_BOX_CREDENTIALS.clientSecret,
        FAKE_BOX_CREDENTIALS.refreshToken,
        FAKE_BOX_CREDENTIALS.accessToken,
      ],
      memory: () => process.memoryUsage.rss(),
    }),
  )('$name', ({ run: chaos }) => Effect.runPromise(chaos), 60_000)
})

/** The memo as Box extracts it, written here apart from the seed. */
const MEMO_TEXT = [
  'Acme investment memo',
  'Thesis: the data room tool every fund already wants.',
  'Risks: a crowded market and a two-person team.',
  'Terms: $2m seed at $10m post.',
].join('\n')

describe('a Box Note', () => {
  it('exports to its text, and hashes to our own sha of that text — the same every read', async () => {
    const { api, source } = subject()
    const first = await read(source, '2001')
    expect(first.file).toMatchObject({
      mime: 'text/plain',
      name: 'Investment memo.txt',
      parentId: '1001',
    })
    expect(new TextDecoder().decode(first.bytes)).toBe(MEMO_TEXT)
    expect(first.sha).toBe(await run(sha256Hex(encoder.encode(MEMO_TEXT))))
    // Unlike a Drive export, the text is stable: a re-read is the same sha.
    expect((await read(source, '2001')).sha).toBe(first.sha)
    // The note's JSON body is never what is delivered.
    expect(api.requests.some((r) => r.path === '/files/2001/content')).toBe(
      false,
    )
  })

  it('lists under its own mime, not the export’s', async () => {
    const { source } = subject()
    const page = await run(source.listFolder('1001'))
    expect(page.entries.find((e) => e.id === '2001')?.mime).toBe(BOX_NOTE_MIME)
  })

  it('an edit is a new changeToken and new text', async () => {
    const { api, source } = subject()
    const before = await read(source, '2001')
    api.edit('2001', ['Acme investment memo', 'Passed: valuation.'])
    const after = await read(source, '2001')
    expect(after.file.changeToken).not.toBe(before.file.changeToken)
    expect(new TextDecoder().decode(after.bytes)).toBe(
      'Acme investment memo\nPassed: valuation.',
    )
  })

  it('a representation still rendering is read after one status check', async () => {
    const { api, source } = subject()
    api.pendingText('2001', 1)
    expect((await read(source, '2001')).sha).toBe(
      await run(sha256Hex(encoder.encode(MEMO_TEXT))),
    )
    expect(
      api.requests.filter((r) => r.path.includes('/representations/')),
    ).toHaveLength(2)
  })

  it('one still rendering after the check is a wait, not a failure', async () => {
    const { api, source } = subject()
    api.pendingText('2001', 2)
    expect(await failureOf(source.getFile('2001'))).toMatchObject({
      _tag: 'RateLimited',
      retryAfterMs: 5000,
    })
  })
})

describe('getFile', () => {
  it('follows the download redirect without sending the token off Box’s API', async () => {
    const { api, source } = subject()
    const { file, bytes } = await read(source, '2005')
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7 Acme term sheet')
    expect(file).toMatchObject({
      mime: 'application/pdf',
      name: 'Term sheet.pdf',
      parentId: '1002',
    })
    const downloads = api.requests.filter((r) => r.endpoint === 'download')
    expect(downloads.map((r) => r.url)).toEqual([
      `${BOX_DOWNLOAD}/d/1/t1/download`,
    ])
  })

  it('reads a mime from the extension, since Box sends none', async () => {
    const { source } = subject()
    expect((await read(source, '2003')).file.mime).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
  })

  it('a folder id or a non-numeric id is NotFound, the second without a request', async () => {
    const { api, source } = subject()
    expect(await failureOf(source.getFile('1001'))).toMatchObject({
      _tag: 'NotFound',
      id: '1001',
    })
    const before = api.requests.length
    expect(await failureOf(source.getFile('../users/me'))).toMatchObject({
      _tag: 'NotFound',
    })
    expect(api.requests.length).toBe(before)
  })
})

describe('listFolder', () => {
  it('asks Box for the fields an entry needs, and skips web links', async () => {
    const { api, source } = subject()
    const page = await run(source.listFolder('1001'))
    expect(page.entries.map((e) => e.id)).toEqual([
      '1002',
      '1003',
      '2002',
      '2003',
      '2001',
    ])
    const deck = page.entries.find((e) => e.id === '2002')
    expect(deck).toMatchObject({
      kind: 'file',
      size: 23,
      parentId: '1001',
      modifiedAt: expect.stringMatching(/^2026-01-01T\d\d:\d\d:\d\d\.000Z$/),
    })
    const listing = api.requests.find((r) => r.path === '/folders/1001/items')
    expect(listing?.query).toMatchObject({ usemarker: 'true' })
    expect(listing?.query.fields?.split(',').sort()).toEqual(
      ['etag', 'id', 'modified_at', 'name', 'parent', 'size', 'type'].sort(),
    )
  })

  it('ends the listing at the first web link: Box lists them last', async () => {
    const { api, source } = subject()
    api.add({ kind: 'folder', id: '1100', name: 'Links', parentId: '1001' })
    for (const id of ['3101', '3102', '3103'])
      api.add({
        kind: 'web_link',
        id,
        name: `Link ${id}`,
        parentId: '1100',
        url: 'https://acme.example',
      })
    api.add({
      kind: 'file',
      id: '2100',
      name: 'Reading list.txt',
      parentId: '1100',
      content: 'read me',
    })
    const seen: Array<string> = []
    let cursor: string | undefined
    do {
      const page = await run(
        source.listFolder(
          '1100',
          cursor === undefined ? { pageSize: 1 } : { pageSize: 1, cursor },
        ),
      )
      seen.push(...page.entries.map((e) => e.id))
      cursor = page.next
    } while (cursor !== undefined)
    expect(seen).toEqual(['2100'])
    expect(
      api.requests.filter((r) => r.path === '/folders/1100/items'),
    ).toHaveLength(2)
  })

  it('a marker Box does not know is CursorExpired', async () => {
    const { source } = subject()
    expect(
      await failureOf(
        source.listFolder('1001', { cursor: 'bm90LWEtbWFya2Vy' }),
      ),
    ).toMatchObject({ _tag: 'CursorExpired', cursor: 'bm90LWEtbWFya2Vy' })
  })
})

describe('resolveLink', () => {
  it('asks Box what a shared link names', async () => {
    const { source } = subject()
    expect(
      await run(source.resolveLink('https://app.box.com/s/acmedataroom')),
    ).toEqual({ folderId: '1001' })
    expect(
      await run(source.resolveLink('https://app.box.com/s/acmedeck')),
    ).toEqual({ fileId: '2002' })
    expect(
      await failureOf(source.resolveLink('https://app.box.com/s/nobody')),
    ).toMatchObject({ _tag: 'NotFound' })
  })

  it('a link to a trashed item is NotFound', async () => {
    const { api, source } = subject()
    api.trash('2002')
    expect(
      await failureOf(source.resolveLink('https://app.box.com/file/2002')),
    ).toMatchObject({ _tag: 'NotFound', id: '2002' })
  })
})

describe('changes, over the events stream', () => {
  it('reads Box’s 64-bit stream position exactly, where JSON numbers would round it', async () => {
    const { source } = subject()
    const start = await run(source.changes(null))
    expect(start.next).toMatch(/^\d{19}$/)
    expect(String(Number(start.next))).not.toBe(start.next)
    const again = await run(source.changes(start.next))
    expect(again).toEqual({ changes: [], next: start.next })
  })

  it('reports each item once at its latest state, a trash as a removal', async () => {
    const { api, source } = subject()
    const start = await run(source.changes(null))
    api.add({
      kind: 'file',
      id: '2200',
      name: 'Draft.pdf',
      parentId: '1002',
      content: '%PDF-1.7 draft',
    })
    api.rename('2200', 'Final.pdf')
    api.move('2003', '1003')
    api.trash('2005')
    const page = await run(source.changes(start.next))
    expect(page.changes).toEqual([
      {
        _tag: 'changed',
        entry: expect.objectContaining({
          id: '2200',
          name: 'Final.pdf',
          parentId: '1002',
          mime: 'application/pdf',
        }),
      },
      {
        _tag: 'changed',
        entry: expect.objectContaining({ id: '2003', parentId: '1003' }),
      },
      { _tag: 'removed', id: '2005' },
    ])
    for (const change of page.changes)
      if (change._tag === 'changed')
        expect(Object.keys(change.entry).join()).not.toMatch(/sha/)
    expect(await run(source.changes(page.next))).toEqual({
      changes: [],
      next: page.next,
    })
    // Every events read asked for the tree's changes only.
    for (const r of api.requests.filter((q) => q.path === '/events'))
      if (r.query.stream_position !== 'now')
        expect(r.query.stream_type).toBe('changes')
  })

  it('a position Box no longer holds is CursorExpired; the re-list path reads the tree as it is', async () => {
    const { api, source } = subject()
    const start = await run(source.changes(null))
    api.trash('2002')
    api.chaos.evictCursors()
    expect(await failureOf(source.changes(start.next))).toEqual(
      expect.objectContaining({ _tag: 'CursorExpired', cursor: start.next }),
    )
    // What the poll does next: a fresh cursor, and the bound folder walked again.
    const fresh = await run(source.changes(null))
    expect((await run(source.changes(fresh.next))).changes).toEqual([])
    const relisted = await run(source.listFolder('1001'))
    expect(relisted.entries.map((e) => e.id)).not.toContain('2002')
  })

  it('a cursor that is not a stream position is CursorExpired without a request', async () => {
    const { api, source } = subject()
    expect(await failureOf(source.changes('{"v":1}'))).toMatchObject({
      _tag: 'CursorExpired',
      cursor: '{"v":1}',
    })
    expect(api.requests).toEqual([])
  })
})

describe('pickerConfig', () => {
  it('names Box’s Content Picker and carries no token', async () => {
    const { api, source } = subject()
    const config = await run(source.pickerConfig())
    expect(config).toMatchObject({ provider: 'box', picker: 'ContentPicker' })
    expect(JSON.stringify(config)).not.toContain(api.accessToken)
  })
})
