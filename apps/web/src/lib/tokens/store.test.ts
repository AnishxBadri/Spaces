import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { API_SCOPES } from './scopes'
import { createApiTokenProgram } from './store'

/**
 * SPA-48 — one personal-token store, not a second. The MCP server and the
 * `/api/v1` door authenticate against the same `api_token` rows, and those
 * rows have one way in: `createApiTokenProgram`. Text scans in the shape of
 * `one-door.test.ts` — no import of what they guard, and a failure names the
 * file.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const SELF = relative(repoRoot, fileURLToPath(import.meta.url))

function sourceFiles(dir: string): Array<string> {
  let names: Array<string>
  try {
    names = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  } catch {
    return []
  }
  return names
    .filter((name) => /\.(tsx?|sql)$/.test(name))
    .filter((name) => !name.split('/').includes('node_modules'))
    .map((name) => join(dir, name))
}

function scanRoots(): Array<string> {
  const roots = [join(repoRoot, 'apps/web/src'), join(repoRoot, 'scripts')]
  for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
    roots.push(join(repoRoot, 'packages', pkg, 'src'))
  }
  return roots
}

/** Every file, tests included, whose text matches — minus this one. */
function filesMatching(pattern: RegExp): Array<string> {
  const hits: Array<string> = []
  for (const root of scanRoots()) {
    for (const file of sourceFiles(root)) {
      const path = relative(repoRoot, file)
      if (path === SELF) continue
      if (pattern.test(readFileSync(file, 'utf8'))) hits.push(path)
    }
  }
  return hits.sort()
}

const INSERT_API_TOKEN =
  /\.insert\(\s*apiToken\s*\)|insert\s+into\s+"?api_token"?/i

describe('one api_token store', () => {
  it('has exactly one insert path, the store’s mint', () => {
    expect(
      filesMatching(INSERT_API_TOKEN),
      'api_token has one writer: createApiTokenProgram in lib/tokens/store.ts. Mint through it — tests included',
    ).toEqual(['apps/web/src/lib/tokens/store.ts'])
  })

  it('declares the api_token table once', () => {
    expect(filesMatching(/pgTable\(\s*'api_token'/)).toEqual([
      'packages/db/src/schema/tokens.ts',
    ])
  })

  it('has one hashing scheme — hashApiToken — and one constant-time comparison', () => {
    const store = readFileSync(
      join(repoRoot, 'apps/web/src/lib/tokens/store.ts'),
      'utf8',
    )
    expect(store).toContain("createHash('sha256')")
    expect(store).toContain('timingSafeEqual(stored, presented)')
  })

  it('the scanner matches the spellings it guards', () => {
    expect(INSERT_API_TOKEN.test('db.insert(apiToken).values({})')).toBe(true)
    expect(INSERT_API_TOKEN.test('INSERT INTO "api_token" (id)')).toBe(true)
    expect(INSERT_API_TOKEN.test('db.insert(apiTokenLog)')).toBe(false)
  })
})

describe('scopes at mint', () => {
  const refusal = (scopes: ReadonlyArray<string>) =>
    Effect.runPromise(
      Effect.flip(
        createApiTokenProgram({ userId: FIXTURE_ACTOR.id, name: 's', scopes }),
      ),
    )

  it('keeps the pinned order and drops duplicates', async () => {
    const result = await Effect.runPromise(
      createApiTokenProgram({
        userId: FIXTURE_ACTOR.id,
        name: 'all',
        scopes: [
          'suggestions:write',
          'records:read',
          'capture:write',
          'records:read',
        ],
      }),
    )
    expect(result.scopes).toEqual([...API_SCOPES])
  })

  it('refuses a scope the pinned list does not name', async () => {
    expect(await refusal(['records:read', 'admin:*'])).toMatchObject({
      _tag: 'ApiTokenRejected',
      message: 'Unknown scope admin:*',
    })
  })

  it('grants nothing when none are asked for', async () => {
    const result = await Effect.runPromise(
      createApiTokenProgram({ userId: FIXTURE_ACTOR.id, name: 'bare' }),
    )
    expect(result.scopes).toEqual([])
  })
})
