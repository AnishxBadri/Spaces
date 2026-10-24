import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { dataDir } from './key'

/**
 * `dataDir()` must not follow the cwd: under `pnpm --filter` that is
 * `apps/web`, so a cwd fallback would mean a fresh `data/`, a freshly
 * generated `secret.key`, and every credential unreadable. Nothing throws
 * when that happens, which is why it is pinned by a test.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

describe('dataDir', () => {
  const saved = process.env.DATA_DIR

  afterEach(() => {
    if (saved === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = saved
  })

  it('anchors on the workspace root, not on cwd', () => {
    delete process.env.DATA_DIR
    expect(existsSync(join(repoRoot, 'pnpm-workspace.yaml'))).toBe(true)
    expect(dataDir()).toBe(join(repoRoot, 'data'))
  })

  it('is the same answer whichever directory the process was started in', () => {
    delete process.env.DATA_DIR
    const fromHere = dataDir()
    const cwd = process.cwd()
    try {
      process.chdir(repoRoot)
      expect(dataDir()).toBe(fromHere)
      process.chdir(join(repoRoot, 'apps/web'))
      expect(dataDir()).toBe(fromHere)
    } finally {
      process.chdir(cwd)
    }
  })

  it('still lets DATA_DIR win — the image sets it', () => {
    process.env.DATA_DIR = '/data'
    expect(dataDir()).toBe('/data')
  })
})
