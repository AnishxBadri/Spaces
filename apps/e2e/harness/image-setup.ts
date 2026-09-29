import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createAdmin } from './admin.ts'
import { ENV, fromEnv } from './shared.ts'
import type { FullConfig } from '@playwright/test'

/**
 * Global setup for the image smoke (SPA-186): nothing is booted here. The
 * app under test is the container CI composed from the image built for this
 * commit, at E2E_IMAGE_URL; this only waits for it and signs in.
 *
 * 1. /api/health must say db ok **and** worker ok before anything clicks —
 *    the upload spec depends on the worker, and a worker that never beats
 *    has to fail here, with the payload, not inside a preview that never
 *    fills. (CI's own wait step says the same first; this keeps a local run
 *    against a composed stack just as honest.)
 * 2. The admin comes from the first-run flow — the token read from
 *    `docker compose logs app`, the same compose project CI started (it
 *    inherits COMPOSE_FILE from the job).
 */
const exec = promisify(execFile)

/**
 * The repo root: compose resolves COMPOSE_FILE's relative entries (CI sets
 * `docker-compose.yml:docker-compose.ci.yml`) against its cwd, and Playwright
 * runs from apps/e2e.
 */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

export default async function imageSetup(config: FullConfig) {
  const url = fromEnv(ENV.imageUrl)
  await waitForDbAndWorker(url)
  const outputDir = config.projects.at(0)?.outputDir ?? 'test-results'
  const storageState = join(outputDir, 'admin.storage.json')
  await createAdmin(
    url,
    async () =>
      (
        await exec('docker', ['compose', 'logs', '--no-color', 'app'], {
          cwd: REPO,
          maxBuffer: 64 * 1024 * 1024,
        })
      ).stdout,
    storageState,
  )
  process.env[ENV.adminStorage] = storageState
}

async function waitForDbAndWorker(url: string) {
  const deadline = Date.now() + 180_000
  let last = 'no answer'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`)
      last = await res.text()
      const body: unknown = JSON.parse(last)
      if (isReady(body)) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error(
    `[e2e] ${url}/api/health never reported db ok and worker ok within 180s — last payload: ${last}`,
  )
}

function isReady(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const db: unknown = Reflect.get(body, 'db')
  const worker: unknown = Reflect.get(body, 'worker')
  return (
    db === 'ok' &&
    typeof worker === 'object' &&
    worker !== null &&
    Reflect.get(worker, 'status') === 'ok'
  )
}
