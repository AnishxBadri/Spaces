import { Effect, Exit } from 'effect'
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest'
import {
  AuthExpired,
  NotFound,
  collisionName,
  pathSegments,
} from '../storage-source.ts'
import type { StorageSource, WritableStorageSource } from '../storage-source.ts'
import {
  DOCX_MIME,
  DRIVE_API,
  DRIVE_UPLOAD_API,
  FAKE_DRIVE_CHAOS_FIXTURE,
  FAKE_DRIVE_CREDENTIALS,
  FAKE_DRIVE_FIXTURE,
  FAKE_DRIVE_SCAN,
  FAKE_DRIVE_SEED,
  FAKE_DRIVE_WRITE_FIXTURE,
  GOOGLE_DOC_MIME,
  LARGE_FILE_MEMORY_BOUND,
  RESUMABLE_CHUNK_MULTIPLE,
  fakeDriveLargeChunks,
  makeFakeDrive,
  makeFakeDriveApi,
  makeSha256,
  sha256Hex,
  storageSourceChaos,
  storageSourceConformance,
  storageSourceWriteConformance,
} from './index.ts'
import type {
  FakeDriveSeedItem,
  StorageSourceChaosSubject,
  StorageSourceSubject,
  StorageSourceWriteSubject,
} from './index.ts'

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

const writableDrive: StorageSourceWriteSubject = {
  make: () => makeFakeDrive().source,
  fixture: FAKE_DRIVE_WRITE_FIXTURE,
}

describe('storage-source write conformance — the fake Drive', () => {
  it.each(storageSourceWriteConformance(writableDrive))('$name', ({ run }) =>
    Effect.runPromise(run),
  )
})

/** The one write case whose name starts `prefix`, run against `make`: its failure, or null. */
const writeOutcome = async (
  make: () => WritableStorageSource,
  prefix: string,
) => {
  const found = storageSourceWriteConformance({
    ...writableDrive,
    make,
  }).filter((c) => c.name.startsWith(prefix))
  expect(found).toHaveLength(1)
  const exit = await Effect.runPromiseExit(found[0].run)
  return Exit.isSuccess(exit) ? null : String(failureOf(exit))
}

describe('the write cases fail when the port does not hold', () => {
  it('fails the concurrent case, naming the fork, when ensureFolder looks and then creates', async () => {
    const naive = (): WritableStorageSource => {
      const drive = makeFakeDrive()
      const ensureFolder = (rootId: string, path: string) =>
        Effect.gen(function* () {
          let at = rootId
          for (const name of pathSegments(path)) {
            const { entries } = yield* drive.source
              .listFolder(at)
              .pipe(Effect.catchTag('CursorExpired', Effect.die))
            const found = entries.find(
              (e) => e.kind === 'folder' && e.name === name,
            )
            // The gap Drive leaves between looking and creating.
            yield* Effect.yieldNow
            at =
              found?.id ??
              drive.create({ kind: 'folder', name, parentId: at }).id
          }
          return at
        })
      return { ...drive.source, ensureFolder }
    }
    expect(await writeOutcome(naive, 'ensureFolder(A/B/C) twice')).toBeNull()
    const failure = await writeOutcome(naive, 'four concurrent')
    expect(failure).toMatch(/four concurrent ensureFolder\(A\/B\) calls gave/)
  })

  it('fails the revision case when identical bytes make a second file', async () => {
    const failure = await writeOutcome(() => {
      const drive = makeFakeDrive()
      return {
        ...drive.source,
        putFile: (folderId, name, upload) =>
          Effect.flatMap(
            Effect.promise(() => new Response(upload.stream).arrayBuffer()),
            (bytes) =>
              Effect.succeed({
                fileId: drive.create({
                  kind: 'file',
                  name,
                  parentId: folderId,
                  mime: upload.mime,
                  bytes: new Uint8Array(bytes),
                }).id,
                revisionId: 'r1',
                name,
              }),
          ),
      }
    }, 'putFile of identical bytes')
    expect(failure).toContain('made a second file')
  })

  it('fails the docx case when the upload is converted to a native doc', async () => {
    const failure = await writeOutcome(() => {
      const drive = makeFakeDrive()
      return {
        ...drive.source,
        putFile: (folderId, name, upload) =>
          drive.source.putFile(folderId, name, {
            ...upload,
            mime: GOOGLE_DOC_MIME,
          }),
      }
    }, 'putFile never converts')
    expect(failure).toContain(`lists as ${GOOGLE_DOC_MIME} — converted`)
  })

  it('fails the rename case when a replay writes again', async () => {
    const failure = await writeOutcome(() => {
      const drive = makeFakeDrive()
      return {
        ...drive.source,
        rename: (id, name) => Effect.sync(() => drive.rename(id, name)),
      }
    }, 'rename is idempotent')
    expect(failure).toContain('rename replayed changed the file')
  })

  it('fails the move case when a replay is an error', async () => {
    const failure = await writeOutcome(() => {
      const drive = makeFakeDrive()
      let moved = false
      return {
        ...drive.source,
        move: (id, folderId) =>
          moved
            ? Effect.fail(new NotFound({ id }))
            : Effect.sync(() => {
                moved = true
                drive.move(id, folderId)
              }),
      }
    }, 'move is idempotent')
    expect(failure).toMatch(/NotFound/)
  })
})

describe('the fake Drive, written to', () => {
  const upload = (text: string) =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(text)
      return {
        stream: new Blob([bytes]).stream(),
        mime: 'application/pdf',
        sha256: yield* sha256Hex(bytes),
      }
    })

  it('creates a path lazily, once, and shows it as one chain', async () => {
    const drive = makeFakeDrive()
    expect(drive.tree('root')).not.toContain('Portfolio')
    const leaf = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 4 }, () =>
          drive.source.ensureFolder('root', 'Portfolio/Acme/Seed/Legal'),
        ),
        { concurrency: 'unbounded' },
      ),
    )
    expect(new Set(leaf).size).toBe(1)
    expect(drive.tree('root').filter((p) => p.startsWith('Portfolio'))).toEqual(
      [
        'Portfolio',
        'Portfolio/Acme',
        'Portfolio/Acme/Seed',
        'Portfolio/Acme/Seed/Legal',
      ],
    )
  })

  it('keeps every revision of a file put twice with the same bytes', async () => {
    const drive = makeFakeDrive()
    const put = (text: string) =>
      Effect.flatMap(upload(text), (u) =>
        drive.source.putFile('legal', 'SPA.pdf', u),
      )
    const first = await Effect.runPromise(put('%PDF spa'))
    const second = await Effect.runPromise(put('%PDF spa'))
    expect(drive.revisions(first.fileId)).toEqual([
      first.revisionId,
      second.revisionId,
    ])
    expect(drive.driveFields(first.fileId)).toMatchObject({
      headRevisionId: second.revisionId,
      sha256Checksum: await Effect.runPromise(
        sha256Hex(new TextEncoder().encode('%PDF spa')),
      ),
    })
  })

  it('refuses a write once revoked, and a write to a missing folder is NotFound', async () => {
    const drive = makeFakeDrive()
    drive.revoke()
    const revoked = await Effect.runPromiseExit(
      drive.source.ensureFolder('root', 'A'),
    )
    expect(failureOf(revoked)).toMatchObject({ _tag: 'AuthExpired' })
    drive.restore()
    const missing = await Effect.runPromiseExit(
      Effect.flatMap(upload('x'), (u) =>
        drive.source.putFile('nowhere', 'x.pdf', u),
      ),
    )
    expect(failureOf(missing)).toMatchObject({
      _tag: 'NotFound',
      id: 'nowhere',
    })
  })
})

describe('collisionName', () => {
  it('suffixes before the extension, and a dotfile or a bare name at the end', () => {
    expect(collisionName('Term sheet.pdf', 1)).toBe('Term sheet.pdf')
    expect(collisionName('Term sheet.pdf', 2)).toBe('Term sheet (2).pdf')
    expect(collisionName('archive.tar.gz', 3)).toBe('archive.tar (3).gz')
    expect(collisionName('README', 2)).toBe('README (2)')
    expect(collisionName('.env', 2)).toBe('.env (2)')
  })
})

const chaosDrive: StorageSourceChaosSubject = {
  make: () => {
    const drive = makeFakeDrive({ largeFiles: [FAKE_DRIVE_SCAN] })
    return { source: drive.source, chaos: drive.chaos }
  },
  fixture: FAKE_DRIVE_CHAOS_FIXTURE,
  secrets,
  memory: () => process.memoryUsage.rss(),
}

/** The large-file case streams 200 MB through a pure-JS SHA-256; the rest are quick. */
const CHAOS_TIMEOUT_MS = 120_000

describe('storage-source chaos — the fake Drive', () => {
  it.each(storageSourceChaos(chaosDrive))(
    '$name',
    ({ run }) => Effect.runPromise(run),
    CHAOS_TIMEOUT_MS,
  )

  it('cannot be handed a subject without a chaos handle', () => {
    expectTypeOf<StorageSourceSubject>().not.toExtend<StorageSourceChaosSubject>()
    expectTypeOf<StorageSourceChaosSubject>().not.toExtend<StorageSourceSubject>()
  })
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

/** The one chaos case whose name starts `prefix`, run: its failure message, or null. */
const chaosOutcome = async (
  subject: StorageSourceChaosSubject,
  prefix: string,
) => {
  const found = storageSourceChaos(subject).filter((c) =>
    c.name.startsWith(prefix),
  )
  expect(found).toHaveLength(1)
  const exit = await Effect.runPromiseExit(found[0].run)
  return Exit.isSuccess(exit) ? null : failureOf(exit)
}

/** The fake Drive with the scan, one source method or toggle replaced. */
const chaosWith = (
  change: (
    drive: ReturnType<typeof makeFakeDrive>,
  ) => Partial<ReturnType<StorageSourceChaosSubject['make']>>,
): StorageSourceChaosSubject => ({
  ...chaosDrive,
  make: () => {
    const drive = makeFakeDrive({ largeFiles: [FAKE_DRIVE_SCAN] })
    return { source: drive.source, chaos: drive.chaos, ...change(drive) }
  },
})

describe('the chaos cases fail when the bad day does not show', () => {
  it('fails the RateLimited case, naming it, when the rate-limit toggle is off', async () => {
    const failure = await chaosOutcome(
      chaosWith((drive) => ({
        chaos: { ...drive.chaos, rateLimit: () => {} },
      })),
      'a 429 with Retry-After: 1',
    )
    expect(failure).toMatchObject({ _tag: 'ConformanceFailure' })
    expect(String(failure)).toContain(
      'getFolder(dataroom) after a seeded 429 with Retry-After: 1 succeeded, expected RateLimited',
    )
  })

  it('fails the RateLimited case when the hint is lost', async () => {
    const failure = await chaosOutcome(
      chaosWith((drive) => ({
        chaos: {
          ...drive.chaos,
          rateLimit: (calls) => drive.rateLimit(calls, 5000),
        },
      })),
      'a 429 with Retry-After: 1',
    )
    expect(String(failure)).toContain(
      'carried retryAfterMs 5000, not the 1000 that Retry-After: 1 gave',
    )
  })

  it('fails the vanished-file case when getFile throws instead of failing NotFound', async () => {
    const failure = await chaosOutcome(
      chaosWith((drive) => ({
        source: {
          ...drive.source,
          getFile: (id) =>
            Effect.catchTag(drive.source.getFile(id), 'NotFound', () =>
              Effect.promise(() => Promise.reject(new Error('404 from Drive'))),
            ),
        },
      })),
      'a file deleted between list and get',
    )
    expect(String(failure)).toContain(
      'getFile(deck) deleted after it was listed died (Error: 404 from Drive) — a throw, not a typed failure, expected NotFound',
    )
  })

  it('fails the batch case when one missing file sinks the rest', async () => {
    const failure = await chaosOutcome(
      chaosWith((drive) => {
        let sunk = false
        return {
          source: {
            ...drive.source,
            getFile: (id) =>
              Effect.suspend(() =>
                sunk
                  ? Effect.fail(new AuthExpired({ reason: 'batch aborted' }))
                  : Effect.tapError(drive.source.getFile(id), () =>
                      Effect.sync(() => {
                        sunk = true
                      }),
                    ),
              ),
          },
        }
      }),
      'half a batch failing',
    )
    expect(String(failure)).toContain(
      'getFile(captable) failed AuthExpired; getFile(memo) failed AuthExpired',
    )
  })

  it('fails the CursorExpired case when an evicted cursor still reads', async () => {
    const failure = await chaosOutcome(
      chaosWith((drive) => ({
        chaos: { ...drive.chaos, evictCursors: () => {} },
      })),
      'a cursor the provider has forgotten',
    )
    expect(String(failure)).toContain('succeeded, expected CursorExpired')
  })

  it('fails the replay case when the same cursor gives a different page', async () => {
    const failure = await chaosOutcome(
      chaosWith((drive) => {
        // Consumed on read: a cursor's changes are handed out once.
        const read = new Set<string>()
        return {
          source: {
            ...drive.source,
            changes: (cursor) =>
              Effect.map(drive.source.changes(cursor), (page) => {
                if (cursor === null || !read.has(cursor)) {
                  if (cursor !== null) read.add(cursor)
                  return page
                }
                return { ...page, changes: [] }
              }),
          },
        }
      }),
      'a page of changes replayed',
    )
    expect(String(failure)).toMatch(
      /^ConformanceFailure: changes\(\S+\) gave .*"removed".*, then \{"changes":\[\],.*\} replayed$/,
    )
  })

  it('fails the revoked case when a read still answers', async () => {
    const failure = await chaosOutcome(
      chaosWith((drive) => ({
        source: {
          ...drive.source,
          getFolder: (id) =>
            Effect.flatMap(
              Effect.sync(() => drive.restore()),
              () => drive.source.getFolder(id),
            ),
        },
      })),
      'a token revoked mid-run',
    )
    expect(String(failure)).toContain(
      'getFolder with the token revoked succeeded, expected AuthExpired',
    )
  })

  it(
    'fails the large-file case, naming the bound, when the provider buffers the file whole',
    async () => {
      const failure = await chaosOutcome(
        chaosWith((drive) => ({
          source: {
            ...drive.source,
            getFile: (id) =>
              Effect.flatMap(drive.source.getFile(id), (file) =>
                Effect.promise(async () => {
                  const held: Array<Uint8Array> = []
                  const reader = file.stream.getReader()
                  for (;;) {
                    const { done, value } = await reader.read()
                    if (done) break
                    held.push(value)
                  }
                  return {
                    ...file,
                    stream: new ReadableStream<Uint8Array>({
                      pull(controller) {
                        const next = held.shift()
                        if (next === undefined) controller.close()
                        else controller.enqueue(next)
                      },
                    }),
                  }
                }),
              ),
          },
        })),
        'getFile streams a 200 MB file',
      )
      expect(String(failure)).toContain(
        `over the ${LARGE_FILE_MEMORY_BOUND / 1024 / 1024} MB bound — the file was buffered`,
      )
    },
    CHAOS_TIMEOUT_MS,
  )
})

describe('makeSha256', () => {
  it('agrees with WebCrypto at every padding edge, fed in uneven pieces', async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 7 + 3) % 256)
      const hash = makeSha256()
      for (let at = 0; at < length; at += 13)
        hash.update(bytes.subarray(at, at + 13))
      expect(hash.hex()).toBe(await Effect.runPromise(sha256Hex(bytes)))
    }
  })
})

describe('the fake Drive', () => {
  it('lists a large file at its size and makes its chunks only as they are read', async () => {
    const drive = makeFakeDrive({ largeFiles: [FAKE_DRIVE_SCAN] })
    const page = await Effect.runPromise(drive.source.listFolder('legal'))
    expect(page.entries.find((e) => e.id === 'scan')).toMatchObject({
      kind: 'file',
      size: FAKE_DRIVE_SCAN.size,
    })
    const file = await Effect.runPromise(drive.source.getFile('scan'))
    const reader = file.stream.getReader()
    const first = await reader.read()
    expect(first.value?.byteLength).toBe(FAKE_DRIVE_SCAN.chunkSize)
    await reader.cancel()
    const [chunk] = fakeDriveLargeChunks(FAKE_DRIVE_SCAN)
    expect(first.value).toEqual(chunk)
  })

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

  it('names the folder a file sits in, and the API answers its parents', async () => {
    const drive = makeFakeDrive()
    const file = await Effect.runPromise(drive.source.getFile('spa'))
    expect(file.parentId).toBe('legal')
    const api = makeFakeDriveApi()
    const response = await api.fetch(
      `${DRIVE_API}/files/spa?fields=id,parents`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${api.accessToken}` },
      },
    )
    expect(await response.json()).toEqual({ id: 'spa', parents: ['legal'] })
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

describe('the fake Drive API, written to', () => {
  const send = (
    api: ReturnType<typeof makeFakeDriveApi>,
    method: string,
    url: string,
    init: {
      readonly headers?: Record<string, string>
      readonly body?: string | Uint8Array<ArrayBuffer>
    } = {},
  ) =>
    api.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${api.accessToken}`,
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    })

  const folder = (name: string) =>
    JSON.stringify({
      name,
      parents: ['root'],
      mimeType: 'application/vnd.google-apps.folder',
    })

  it('creates a second folder of the same name, as Drive does', async () => {
    const api = makeFakeDriveApi()
    const one = await send(api, 'POST', `${DRIVE_API}/files?fields=id`, {
      body: folder('Legal'),
    })
    const two = await send(api, 'POST', `${DRIVE_API}/files?fields=id`, {
      body: folder('Legal'),
    })
    const ids = [await one.json(), await two.json()]
    expect(ids[0]).not.toEqual(ids[1])
    expect(api.drive.tree('root').filter((p) => p === 'Legal')).toHaveLength(2)
  })

  const start = async (
    api: ReturnType<typeof makeFakeDriveApi>,
    mimeType: string,
  ) => {
    const response = await send(
      api,
      'POST',
      `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,mimeType`,
      { body: JSON.stringify({ name: 'Memo', parents: ['root'], mimeType }) },
    )
    expect(response.status).toBe(200)
    return response.headers.get('location') ?? ''
  }

  it('holds a resumable upload to the 256 KiB rule, and lands it on the last chunk', async () => {
    const api = makeFakeDriveApi()
    const session = await start(api, DOCX_MIME)
    const odd = await send(api, 'PUT', session, {
      headers: { 'content-range': 'bytes 0-9/*' },
      body: new Uint8Array(10),
    })
    expect(odd.status).toBe(400)
    const chunk = new Uint8Array(RESUMABLE_CHUNK_MULTIPLE).fill(7)
    const partial = await send(api, 'PUT', session, {
      headers: {
        'content-range': `bytes 0-${chunk.byteLength - 1}/*`,
      },
      body: chunk,
    })
    expect(partial.status).toBe(308)
    expect(partial.headers.get('range')).toBe(`bytes=0-${chunk.byteLength - 1}`)
    const done = await send(api, 'PUT', session, {
      headers: { 'content-range': `bytes */${chunk.byteLength}` },
    })
    expect(done.status).toBe(200)
    expect(await done.json()).toMatchObject({ mimeType: DOCX_MIME })
  })

  it('converts only when the metadata names a native mime', async () => {
    const api = makeFakeDriveApi()
    const session = await start(api, GOOGLE_DOC_MIME)
    const done = await send(api, 'PUT', session, {
      headers: { 'content-range': 'bytes 0-3/4' },
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    })
    expect(await done.json()).toMatchObject({ mimeType: GOOGLE_DOC_MIME })
  })

  it('refuses a second parent: a move must remove the old one', async () => {
    const api = makeFakeDriveApi()
    const added = await send(
      api,
      'PATCH',
      `${DRIVE_API}/files/deck?addParents=legal`,
      { body: '{}' },
    )
    expect(added.status).toBe(403)
    const moved = await send(
      api,
      'PATCH',
      `${DRIVE_API}/files/deck?addParents=legal&removeParents=dataroom&fields=parents`,
      { body: '{}' },
    )
    expect(await moved.json()).toEqual({ parents: ['legal'] })
  })
})
