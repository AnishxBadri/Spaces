import { Effect, Exit } from 'effect'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { StorageSource } from '../storage-source.ts'
import {
  DOCX_MIME,
  FAKE_DRIVE_CREDENTIALS,
  FAKE_DRIVE_FIXTURE,
  FAKE_DRIVE_SEED,
  GOOGLE_DOC_MIME,
  makeFakeDrive,
  sha256Hex,
  storageSourceConformance,
} from './index.ts'
import type { FakeDriveSeedItem, StorageSourceSubject } from './index.ts'

beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the storage-source suite must not reach the network')
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const secrets = [
  FAKE_DRIVE_CREDENTIALS.clientSecret,
  FAKE_DRIVE_CREDENTIALS.refreshToken,
]

const fakeDrive: StorageSourceSubject = {
  make: () => makeFakeDrive().source,
  fixture: FAKE_DRIVE_FIXTURE,
  secrets,
}

describe('storage-source conformance — the fake Drive', () => {
  it.each(storageSourceConformance(fakeDrive))('$name', ({ run }) =>
    Effect.runPromise(run),
  )
})

const failureOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected a failure')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

/** Every case of the suite run against `subject`, as `name → failure message | null`. */
const outcomes = async (subject: StorageSourceSubject) => {
  const out: Record<string, string | null> = {}
  for (const c of storageSourceConformance(subject)) {
    const exit = await Effect.runPromiseExit(c.run)
    out[c.name] = Exit.isSuccess(exit) ? null : String(failureOf(exit))
  }
  return out
}

const without = (id: string): ReadonlyArray<FakeDriveSeedItem> =>
  FAKE_DRIVE_SEED.filter((item) => item.id !== id)

describe('the suite fails loudly rather than skipping', () => {
  it('fails the paging case, naming the entry, when a seeded entry is deleted', async () => {
    const found = await outcomes({
      ...fakeDrive,
      make: () => makeFakeDrive({ seed: without('deck') }).source,
    })
    const failed = Object.entries(found).filter(([, f]) => f !== null)
    expect(failed).toEqual([
      [
        'listFolder at a page size of 2 returns every seeded entry exactly once across cursors',
        expect.stringContaining('never returned deck'),
      ],
    ])
  })

  it('fails the export case when the native doc is gone', async () => {
    const found = await outcomes({
      ...fakeDrive,
      make: () => makeFakeDrive({ seed: without('memo') }).source,
    })
    expect(
      found[
        'getFile on the native doc yields exported bytes and a mime, hashed here and not by the provider'
      ],
    ).toContain('native doc memo is not listed in dataroom')
  })

  it('fails the picker case when a secret leaks into the config', async () => {
    const leaky = (): StorageSource => {
      const { source } = makeFakeDrive()
      return {
        ...source,
        pickerConfig: () =>
          Effect.succeed({ token: FAKE_DRIVE_CREDENTIALS.refreshToken }),
      }
    }
    const found = await outcomes({ ...fakeDrive, make: leaky })
    expect(
      found[
        'pickerConfig is plain JSON and holds no client secret or refresh token'
      ],
    ).toContain("reaches 1 of the connection's secrets")
  })

  it('fails when a provider reports its own hash', async () => {
    const hashy = (): StorageSource => {
      const drive = makeFakeDrive()
      return {
        ...drive.source,
        getFile: (id) =>
          Effect.map(drive.source.getFile(id), (file) => ({
            ...file,
            md5Checksum: drive.providerHash(id),
          })),
      }
    }
    const found = await outcomes({ ...fakeDrive, make: hashy })
    expect(
      found[
        'getFile on the native doc yields exported bytes and a mime, hashed here and not by the provider'
      ],
    ).toContain('carries md5Checksum')
  })
})

describe('the fake Drive', () => {
  const read = (stream: ReadableStream<Uint8Array>) =>
    new Response(stream).arrayBuffer().then((b) => new Uint8Array(b))

  it('lists the native doc under its own mime and streams its docx export', async () => {
    const drive = makeFakeDrive()
    const page = await Effect.runPromise(drive.source.listFolder('dataroom'))
    const memo = page.entries.find((e) => e.id === 'memo')
    expect(memo).toMatchObject({ mime: GOOGLE_DOC_MIME, size: null })
    const file = await Effect.runPromise(drive.source.getFile('memo'))
    expect(file).toMatchObject({
      mime: DOCX_MIME,
      name: 'Investment memo.docx',
    })
    const ours = await Effect.runPromise(sha256Hex(await read(file.stream)))
    expect(ours).toMatch(/^[0-9a-f]{64}$/)
    expect(drive.providerHash('memo')).toBeDefined()
    expect(ours).not.toBe(drive.providerHash('memo'))
  })

  it('reports a rate limit with its retry hint, then answers', async () => {
    const drive = makeFakeDrive()
    drive.rateLimit(1, 2500)
    const exit = await Effect.runPromiseExit(drive.source.getFolder('board'))
    expect(failureOf(exit)).toMatchObject({
      _tag: 'RateLimited',
      retryAfterMs: 2500,
    })
    await expect(
      Effect.runPromise(drive.source.getFolder('board')),
    ).resolves.toMatchObject({ id: 'board' })
  })

  it('fails every call AuthExpired once revoked, picker included', async () => {
    const drive = makeFakeDrive()
    drive.revoke()
    for (const attempt of [
      drive.source.listFolder('root'),
      drive.source.changes(null),
      drive.source.pickerConfig(),
    ]) {
      const exit = await Effect.runPromiseExit(attempt)
      expect(failureOf(exit)).toMatchObject({ _tag: 'AuthExpired' })
    }
    drive.restore()
    await expect(
      Effect.runPromise(drive.source.pickerConfig()),
    ).resolves.toMatchObject({ provider: 'google-drive' })
  })

  it('feeds renames, edits, moves, additions and removals to changes, latest state once per id', async () => {
    const drive = makeFakeDrive()
    const start = await Effect.runPromise(drive.source.changes(null))
    drive.rename('deck', 'Acme deck v2.pdf')
    drive.edit('memo', 'revised memo')
    drive.move('spa', 'finance')
    drive.add({
      kind: 'file',
      id: 'nda',
      name: 'NDA.pdf',
      parentId: 'legal',
      mime: 'application/pdf',
      content: '%PDF nda',
    })
    drive.rename('deck', 'Acme deck v3.pdf')
    drive.remove('board')
    const page = await Effect.runPromise(drive.source.changes(start.next))
    expect(
      page.changes.map((c) =>
        c._tag === 'removed' ? `-${c.id}` : `${c.entry.id}@${c.entry.parentId}`,
      ),
    ).toEqual([
      'memo@dataroom',
      'spa@finance',
      'nda@legal',
      'deck@dataroom',
      '-minutes',
      '-board',
    ])
    const deck = page.changes.find(
      (c) => c._tag === 'changed' && c.entry.id === 'deck',
    )
    expect(deck).toMatchObject({ entry: { name: 'Acme deck v3.pdf' } })
    const quiet = await Effect.runPromise(drive.source.changes(page.next))
    expect(quiet.changes).toEqual([])
  })

  it('gives an edited file a new changeToken', async () => {
    const drive = makeFakeDrive()
    const before = await Effect.runPromise(drive.source.getFile('deck'))
    drive.edit('deck', '%PDF new deck')
    const after = await Effect.runPromise(drive.source.getFile('deck'))
    expect(after.changeToken).not.toBe(before.changeToken)
  })

  it('expires every cursor handed out before an eviction, and hands out live ones after', async () => {
    const drive = makeFakeDrive()
    const start = await Effect.runPromise(drive.source.changes(null))
    drive.evictCursors()
    const exit = await Effect.runPromiseExit(drive.source.changes(start.next))
    expect(failureOf(exit)).toMatchObject({
      _tag: 'CursorExpired',
      cursor: start.next,
    })
    const fresh = await Effect.runPromise(drive.source.changes(null))
    await expect(
      Effect.runPromise(drive.source.changes(fresh.next)),
    ).resolves.toMatchObject({ changes: [] })
  })

  it('deletes a file between list and get when told to', async () => {
    const drive = makeFakeDrive()
    drive.vanishAfterList('deck')
    const page = await Effect.runPromise(drive.source.listFolder('dataroom'))
    expect(page.entries.map((e) => e.id)).toContain('deck')
    const exit = await Effect.runPromiseExit(drive.source.getFile('deck'))
    expect(failureOf(exit)).toMatchObject({ _tag: 'NotFound', id: 'deck' })
  })

  it('resolves My Drive, file and open?id= links, and refuses a cursor from another folder', async () => {
    const drive = makeFakeDrive()
    const resolve = (url: string) =>
      Effect.runPromise(drive.source.resolveLink(url))
    await expect(
      resolve('https://drive.google.com/drive/u/0/folders/sd-acme'),
    ).resolves.toEqual({ folderId: 'sd-acme' })
    await expect(
      resolve('https://drive.google.com/file/d/deck/view?usp=sharing'),
    ).resolves.toEqual({ fileId: 'deck' })
    await expect(
      resolve('https://drive.google.com/open?id=minutes'),
    ).resolves.toEqual({ fileId: 'minutes' })
    await expect(resolve('not a url')).resolves.toBeNull()
    const exit = await Effect.runPromiseExit(
      drive.source.resolveLink('https://drive.google.com/file/d/gone/view'),
    )
    expect(failureOf(exit)).toMatchObject({ _tag: 'NotFound', id: 'gone' })

    const first = await Effect.runPromise(
      drive.source.listFolder('dataroom', { pageSize: 2 }),
    )
    expect(first.next).toBeDefined()
    const cross = await Effect.runPromiseExit(
      drive.source.listFolder('legal', { cursor: first.next ?? '' }),
    )
    expect(failureOf(cross)).toMatchObject({ _tag: 'CursorExpired' })
  })
})
