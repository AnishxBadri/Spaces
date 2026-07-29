import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

export function dataDir(): string {
  return process.env.DATA_DIR ?? join(process.cwd(), 'data')
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
      throw new Error(`Corrupt master key at ${keyPath}: not ${KEY_BYTES} bytes`)
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
