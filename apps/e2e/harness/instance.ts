import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import type { ChildProcess } from 'node:child_process'

/**
 * One running copy of the app, the way CI runs it: `apps/web/src/db/boot.ts`
 * migrates and seeds a database nothing else uses, then `node
 * apps/web/.output/server/index.mjs` serves it. Both are *processes* — this
 * package imports nothing from the workspace (the eslint zone holds that),
 * so the product under test is exactly the bytes `vite build` produced.
 *
 * Everything an instance owns is created here and removed by `stop()`: its
 * database (`spaces_e2e_<pid>_<name>`, on the server `DATABASE_URL` names —
 * never `spaces`, never `spaces_test*`), its DATA_DIR (a fresh temp
 * directory, so secret.key and the setup token are this run's and nobody
 * else's) and its server process.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const WEB = join(REPO, 'apps/web')
export const SERVER_ENTRY = join(WEB, '.output/server/index.mjs')
const TSX = join(WEB, 'node_modules/.bin/tsx')

/**
 * Fixed, so a run is reproducible: nothing depends on a key generated into
 * a temp directory. 32 bytes, base64 — the shape `loadMasterKey` checks.
 * It guards nothing but throwaway databases this harness drops.
 */
const MASTER_KEY = Buffer.alloc(32, 0x5e).toString('base64')

export type Instance = {
  readonly name: string
  readonly url: string
  readonly database: string
  readonly databaseUrl: string
  readonly dataDir: string
  readonly logFile: string
  readonly stop: () => Promise<void>
}

/** `DATABASE_URL` from the environment — CI's job env, or the shell. */
export function sourceDatabaseUrl(): URL {
  const raw = process.env.DATABASE_URL
  if (raw === undefined || raw === '')
    throw new Error(
      '[e2e] DATABASE_URL is not set. The harness creates its own databases on the server it names (the dev compose Postgres, or CI’s service).',
    )
  return new URL(raw)
}

export function withDatabase(url: URL, name: string): string {
  const next = new URL(url.toString())
  next.pathname = `/${name}`
  return next.toString()
}

/** A connection to the server's maintenance database, for create/drop. */
export async function maintenance<T>(
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: withDatabase(sourceDatabaseUrl(), 'postgres'),
  })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address === null || typeof address === 'string')
          reject(new Error('[e2e] could not pick a free port'))
        else resolve(address.port)
      })
    })
  })
}

/** Run a process to completion, its output appended to `logFile`. */
function runToEnd(
  cmd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  logFile: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile, { flags: 'a' })
    const child = spawn(cmd, args, { cwd: WEB, env, stdio: 'pipe' })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    child.once('error', reject)
    child.once('exit', (code) => {
      log.end()
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `[e2e] ${cmd} ${args.join(' ')} exited ${code ?? 'on a signal'} — see ${logFile}`,
          ),
        )
    })
  })
}

/** Neither exited nor killed — a signalled process keeps `exitCode` null. */
function running(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null
}

async function waitForHealth(url: string, server: ChildProcess) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (!running(server))
      throw new Error(
        `[e2e] the server exited on boot (${server.exitCode ?? server.signalCode}) — see its log`,
      )
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`[e2e] ${url}/api/health did not answer within 60s`)
}

export async function startInstance(name: string): Promise<Instance> {
  if (!existsSync(SERVER_ENTRY))
    throw new Error(
      `[e2e] ${SERVER_ENTRY} is missing. Run the suite as \`pnpm e2e\` from the repo root — turbo builds @spaces/web first.`,
    )

  const source = sourceDatabaseUrl()
  const database = `spaces_e2e_${process.pid}_${name}`
  const databaseUrl = withDatabase(source, database)
  const dataDir = mkdtempSync(join(tmpdir(), `spaces-e2e-${name}-`))
  const logFile = join(dataDir, '..', `${database}.log`)
  const port = await freePort()
  const url = `http://localhost:${port}`

  let server: ChildProcess | null = null
  const stop = async () => {
    const proc = server
    if (proc !== null && running(proc)) {
      const exited = new Promise((r) => proc.once('exit', r))
      proc.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
      if (running(proc)) proc.kill('SIGKILL')
    }
    await maintenance((c) =>
      c.query(`drop database if exists "${database}" with (force)`),
    )
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(logFile, { force: true })
  }

  try {
    await maintenance((c) => c.query(`create database "${database}"`))

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      APP_URL: url,
      DATA_DIR: dataDir,
      MASTER_KEY,
      PORT: String(port),
      // Nothing the suite runs may reach a test database of the unit suite.
      DATABASE_URL_TEST: '',
    }

    // The boot entry, exactly as the container runs it: tsx with the app's
    // tsconfig (it resolves `#/` from tsconfig paths).
    await runToEnd(
      TSX,
      ['--tsconfig', 'tsconfig.json', 'src/db/boot.ts'],
      env,
      logFile,
    )

    const log = createWriteStream(logFile, { flags: 'a' })
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEB,
      env,
      stdio: 'pipe',
    })
    child.stdout.pipe(log)
    child.stderr.pipe(log)
    server = child
    await waitForHealth(url, child)
  } catch (err) {
    await stop().catch(() => undefined)
    throw err
  }

  return { name, url, database, databaseUrl, dataDir, logFile, stop }
}

/** Every setup token this instance has printed to its log, oldest first. */
export async function printedSetupTokens(logFile: string): Promise<string[]> {
  const text = await readFile(logFile, 'utf8')
  return [...text.matchAll(/First-run setup token: ([0-9a-f]{32})/g)].flatMap(
    (m) => m.at(1) ?? [],
  )
}

/** Rows in `public` of one database, summed — the before/after check. */
export async function publicRowCount(connectionString: string) {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    const tables = await client.query<{ name: string }>(
      `select quote_ident(table_name) as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    )
    if (tables.rows.length === 0) return 0
    const sum = tables.rows
      .map((t) => `(select count(*) from public.${t.name})`)
      .join(' + ')
    const res = await client.query<{ n: string }>(`select (${sum})::text as n`)
    return Number(res.rows.at(0)?.n ?? 0)
  } finally {
    await client.end()
  }
}
