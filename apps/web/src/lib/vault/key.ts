import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Master key resolution, per CONTEXT.md:
 * 1. MASTER_KEY env (base64, 32 bytes) — production/docker path.
 * 2. <DATA_DIR>/secret.key — auto-generated on first boot if absent.
 *
 * Losing this key makes every stored credential unrecoverable. The backup
 * script must include secret.key; docs say this in bold.
 */

const KEY_BYTES = 32

let cached: Buffer | null = null

/**
 * The workspace root — the directory holding `pnpm-workspace.yaml` — found by
 * walking up from this file. Null inside the image, which ships apps/web's
 * `src/` at `/app/src` with no workspace marker; there `DATA_DIR=/data` is set
 * by the Dockerfile and this never runs.
 */
function workspaceRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Where blobs, `secret.key` and the setup token live. DATA_DIR wins; otherwise
 * `<workspace root>/data`.
 *
 * Anchored to the workspace root and NOT to `process.cwd()`: the app's cwd is
 * `apps/web` under `pnpm --filter`, the repo root under a bare `tsx`, and
 * `/app` in the image. A cwd fallback would resolve to a different directory
 * per entry point, and the failure is the quietest one this product has —
 * nothing throws, `loadMasterKey()` generates a fresh key beside the new cwd,
 * and every credential written under the old one is unrecoverable.
 */
export function dataDir(): string {
  const fromEnv = process.env.DATA_DIR
  if (fromEnv) return fromEnv
  return join(workspaceRoot() ?? process.cwd(), 'data')
}

export function loadMasterKey(): Buffer {
  if (cached) return cached

  const fromEnv = process.env.MASTER_KEY
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64')
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `MASTER_KEY must be ${KEY_BYTES} bytes base64-encoded (got ${key.length} bytes). Generate one: openssl rand -base64 32`,
      )
    }
    cached = key
    return key
  }

  const keyPath = join(dataDir(), 'secret.key')
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Corrupt master key at ${keyPath}: not ${KEY_BYTES} bytes`,
      )
    }
    cached = key
    return key
  }

  const key = randomBytes(KEY_BYTES)
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, key.toString('base64') + '\n', { mode: 0o600 })
  console.warn(
    `[vault] Generated master key at ${keyPath}. ` +
      `BACK THIS FILE UP — losing it makes every stored API key unrecoverable.`,
  )
  cached = key
  return key
}
