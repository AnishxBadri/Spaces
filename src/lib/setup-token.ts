import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '#/lib/vault/key'

/**
 * The /setup one-time token — CONTEXT.md's first-run trap #2. Between
 * `docker compose up` and admin creation, /setup would otherwise be open to
 * anyone who can reach the port. The token is generated on first ask,
 * printed to the container logs (the operator is the one person who can
 * read them), required by the setup wizard, and deleted the moment the
 * first admin exists.
 *
 * Stored as a file under DATA_DIR (like secret.key) so it survives web
 * restarts mid-setup and never enters the database.
 */

function tokenPath(): string {
  return join(dataDir(), 'setup-token')
}

/** Generate if absent, always return the current token. */
export function ensureSetupToken(): string {
  const p = tokenPath()
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  const token = randomBytes(16).toString('hex')
  writeFileSync(p, token + '\n', { mode: 0o600 })
  return token
}

/** Loud on purpose — this line is the operator's key to the front door. */
export function printSetupToken(): void {
  const token = ensureSetupToken()
  console.log(
    `\n[setup] First-run setup token: ${token}\n` +
      `[setup] Open /setup and enter it to create the admin account.\n`,
  )
}

export function verifySetupToken(candidate: string): boolean {
  const p = tokenPath()
  if (!existsSync(p)) return false
  const expected = Buffer.from(readFileSync(p, 'utf8').trim())
  const got = Buffer.from(candidate.trim())
  return expected.length === got.length && timingSafeEqual(expected, got)
}

export function clearSetupToken(): void {
  rmSync(tokenPath(), { force: true })
}
