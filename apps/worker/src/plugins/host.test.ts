import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { eq, isNotNull, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { enrichmentRecord, entity, integration } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { JobPermanent } from '@spaces/sdk'
import type { PortName } from '@spaces/sdk'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'

/**
 * Loader step six against real bundles and the test database: the echo and
 * overreach fixtures (built by turbo before this suite, as the worker's
 * devDependencies) and small hand-written bundles for the hooks and the
 * ports this host does not provide. Every bundle is copied under the OS
 * temp dir, so its bare imports resolve only through the loader's hook.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const PROVIDER_URL = 'https://provider.example/v1/organizations/enrich'
const DOMAIN = 'northwind-robotics.example'
const organization = readFileSync(
  path.join(fixtures, 'echo/fixtures/organization.json'),
  'utf8',
)

/** Where a hand-written bundle's hooks report to; read only by this file. */
const HOOK_CALLS = Symbol.for('spaces.worker.host-test.hooks')
const hookCalls: Array<string> = []
Reflect.set(globalThis, HOOK_CALLS, hookCalls)

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-host-')),
    'plugins',
  )
  mkdirSync(root, { recursive: true })
  return root
}

/** Copy a built fixture's dist/ to `<root>/<id>/current/`. */
const install = (root: string, fixture: string) => {
  const dir = path.join(root, fixture, 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(path.join(fixtures, fixture, 'dist', file), path.join(dir, file))
}

/** A one-job bundle written by hand: `ping`, declaring `uses`, plus hooks. */
const writeBundle = (
  root: string,
  id: string,
  options: { readonly uses?: ReadonlyArray<PortName>; readonly hooks?: string },
) => {
  const dir = path.join(root, id, 'current')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 1,
      id,
      version: '0.1.0',
      sdk: '^1.0',
      name: id,
      description: 'A plugin host test bundle.',
      settings: {},
      jobs: { ping: { trigger: 'action', uses: options.uses ?? ['Log'] } },
    }),
  )
  writeFileSync(
    path.join(dir, 'bundle.mjs'),
    [
      "import { Effect } from 'effect'",
      "import { z } from 'zod'",
      `const calls = globalThis[Symbol.for('spaces.worker.host-test.hooks')]`,
      'export default {',
      `  manifest: { id: '${id}', settings: z.object({}) },`,
      '  jobs: { ping: () => Effect.void },',
      options.hooks ?? '',
      '}',
    ].join('\n'),
  )
}

const row = async (capabilityId: string) => {
  const inserted = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true })
      .returning()
  ).at(0)
  if (!inserted) throw new Error('no integration row')
  return inserted
}

const rowById = async (id: string) =>
  (await db.select().from(integration).where(eq(integration.id, id))).at(0)

/** An `Enqueue` with a construction and a finalizer counter. */
const countedEnqueue = () => {
  const counts = { built: 0, released: 0, sent: new Array<string>() }
  const layer = Layer.effect(
    Enqueue,
    Effect.acquireRelease(
      Effect.sync(() => {
        counts.built += 1
        return Enqueue.of({
          enqueue: (queue) =>
            Effect.sync(() => {
              counts.sent.push(queue)
              return `job-${counts.sent.length}`
            }),
        })
      }),
      () =>
        Effect.sync(() => {
          counts.released += 1
        }),
    ),
  )
  return { counts, layer }
}

const fakeFetch = (url: string) =>
  Promise.resolve(
    url === `${PROVIDER_URL}?domain=${DOMAIN}`
      ? new Response(organization, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('not found', { status: 404 }),
  )

const hosts: Array<PluginHost> = []

const boot = async (root: string) => {
  const enqueue = countedEnqueue()
  const logged: Array<string> = []
  const host = makePluginHost({
    enqueue: enqueue.layer,
    fetch: fakeFetch,
    sink: (_level, line) => logged.push(line),
  })
  hosts.push(host)
  const reconciled = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root }),
  )
  const wired = await Effect.runPromise(host.wire(reconciled.loaded))
  return { host, enqueue: enqueue.counts, logged, reconciled, wired }
}

const seedCompany = async () =>
  (
    await resolveEntity({
      kind: 'company',
      name: 'Northwind Robotics',
      keys: { domain: DOMAIN },
      source: { class: 'manual' },
    })
  ).entityId

/** Row counts of every table in `public`, and one entity's whole row. */
const snapshot = async (entityId: string) => {
  const tables = (
    await db.execute<{ name: string }>(
      sql`select tablename as name from pg_tables where schemaname = 'public' order by tablename`,
    )
  ).rows
  const counts: Record<string, number> = {}
  for (const { name } of tables) {
    const counted = (
      await db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(name)}`,
      )
    ).rows.at(0)
    counts[name] = counted?.n ?? -1
  }
  const record = await db.select().from(entity).where(eq(entity.id, entityId))
  return { counts, record }
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  // Reconciliation reads every enabled row; the next test sees none of these.
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
  hookCalls.splice(0)
})

describe('a Layer per (integration, job)', () => {
  it("echo's enrich job holds exactly its six ports and writes through them", async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo')
    const { host, enqueue, logged } = await boot(root)

    expect(host.granted(echo.id, 'enrich')).toEqual([
      'Facts',
      'Http',
      'Identity',
      'Log',
      'Read',
      'Receipts',
    ])
    expect(host.granted(echo.id, 'echo')).toEqual(['Log'])

    const exit = await Effect.runPromiseExit(
      host.invoke(echo.id, 'enrich', { entityId: companyId }),
    )
    expect(exit._tag).toBe('Success')

    const receipts = await db
      .select()
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.entityId, companyId))
    expect(receipts).toHaveLength(1)
    expect(receipts.at(0)).toMatchObject({
      provider: 'echo',
      integrationId: echo.id,
      creditsUsed: 1,
    })
    const company = (
      await db.select().from(entity).where(eq(entity.id, companyId))
    ).at(0)
    expect(company?.values).toMatchObject({
      founded_year: 2019,
      location: 'Pune, India',
    })
    expect(logged.join('\n')).toContain('[plugin:echo] enriched')
    // Identity and Facts were built over the host's one Enqueue.
    expect(enqueue.built).toBe(1)
  })

  it("an overreaching job's undeclared Facts is service-not-found, mapped to JobPermanent, with nothing written", async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'echo')
    install(root, 'overreach')
    const echo = await row('echo')
    const overreach = await row('overreach')
    const { host, logged } = await boot(root)
    expect(host.granted(overreach.id, 'overreach')).toEqual(['Log'])

    const before = await snapshot(companyId)
    const exit = await Effect.runPromiseExit(
      host.invoke(overreach.id, 'overreach', { entityId: companyId }),
    )
    const error = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.findErrorOption(exit.cause))
      : null
    expect(error).toBeInstanceOf(JobPermanent)
    expect(error?.reason).toBe(
      'overreach.overreach used Facts, which its manifest does not grant it: Service not found: spaces/sdk/Facts',
    )
    // The job got as far as its one granted port, and wrote nothing.
    expect(logged.join('\n')).toContain('[plugin:overreach] reaching for Facts')
    expect(await snapshot(companyId)).toEqual(before)

    // The worker stays up: the next job runs.
    const next = await Effect.runPromiseExit(
      host.invoke(echo.id, 'echo', { entityId: companyId }),
    )
    expect(next._tag).toBe('Success')
  })

  it('builds each Layer once and reuses it across invocations', async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo')
    const { host, enqueue } = await boot(root)
    // One Enqueue for the host, built when the first job needing it was wired.
    expect(enqueue.built).toBe(1)

    for (let i = 0; i < 2; i++) {
      const exit = await Effect.runPromiseExit(
        host.invoke(echo.id, 'enrich', { entityId: companyId }),
      )
      expect(exit._tag).toBe('Success')
    }
    expect(enqueue.built).toBe(1)
    expect(enqueue.released).toBe(0)
  })

  it('releasing a plugin closes its job scopes, and releaseAll the shared sender', async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo')
    const { host, enqueue } = await boot(root)
    await Effect.runPromise(
      host.invoke(echo.id, 'enrich', { entityId: companyId }),
    )

    const released = await Effect.runPromise(host.release(echo.id))
    expect(released?.status).toBe('released')
    // The job scopes held only ports; the sender is the host's.
    expect(enqueue.released).toBe(0)
    expect(host.granted(echo.id, 'enrich')).toBeNull()
    const after = await Effect.runPromiseExit(
      host.invoke(echo.id, 'enrich', { entityId: companyId }),
    )
    expect(Exit.isFailure(after)).toBe(true)

    await Effect.runPromise(host.releaseAll())
    expect(enqueue.built).toBe(1)
    expect(enqueue.released).toBe(1)
  })

  it('every job of every plugin shares one Enqueue, and a re-wire reuses it', async () => {
    const root = newPluginsRoot()
    install(root, 'echo')
    writeBundle(root, 'second', { uses: ['Identity', 'Log'] })
    const echo = await row('echo')
    await row('second')
    const { host, enqueue, reconciled } = await boot(root)
    expect(host.granted(echo.id, 'enrich')).not.toBeNull()
    expect(enqueue.built).toBe(1)

    await Effect.runPromise(host.release(echo.id))
    await Effect.runPromise(host.wire(reconciled.loaded))
    expect(host.granted(echo.id, 'enrich')).not.toBeNull()
    expect(enqueue).toMatchObject({ built: 1, released: 0 })

    await Effect.runPromise(host.shutdown())
    expect(host.granted(echo.id, 'enrich')).toBeNull()
    expect(enqueue).toMatchObject({ built: 1, released: 1 })
  })

  it('a row disabled and reconciled again is released', async () => {
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo')
    const { host, enqueue } = await boot(root)
    await db
      .update(integration)
      .set({ enabled: false })
      .where(eq(integration.id, echo.id))
    const { loaded } = await Effect.runPromise(
      reconcilePlugins({ pluginsRoot: root }),
    )
    const verdicts = await Effect.runPromise(host.wire(loaded))
    expect(verdicts.map((v) => [v.id, v.status])).toEqual([
      ['echo', 'released'],
    ])
    expect(host.granted(echo.id, 'enrich')).toBeNull()
    expect(enqueue.released).toBe(0)
  })
})

describe('ports this host does not provide', () => {
  it.each(['Ai', 'PluginDb'] as const)(
    'degrades a plugin whose job declares %s, naming the port, and builds nothing',
    async (port) => {
      const root = newPluginsRoot()
      writeBundle(root, 'reacher', { uses: ['Log', port] })
      const reacher = await row('reacher')
      const { host, enqueue, reconciled } = await boot(root)

      const reason = `job ping uses ${port}, which this host does not provide yet`
      expect(reconciled.verdicts.map((v) => [v.status, v.reason])).toEqual([
        ['degraded', reason],
      ])
      expect(reconciled.loaded).toEqual([])
      expect(await rowById(reacher.id)).toMatchObject({
        status: 'degraded',
        lastError: reason,
      })
      expect(host.granted(reacher.id, 'ping')).toBeNull()
      expect(enqueue.built).toBe(0)
    },
  )
})

describe('lifecycle hooks', () => {
  const hooks = (id: string) =>
    [
      `  onEnable: () => Effect.sync(() => { calls.push('enable:${id}') }),`,
      `  onDisable: () => Effect.sync(() => { calls.push('disable:${id}') }),`,
    ].join('\n')

  it('runs onEnable once on the way in and onDisable on release', async () => {
    const root = newPluginsRoot()
    writeBundle(root, 'hooked', { hooks: hooks('hooked') })
    const hooked = await row('hooked')
    const { host, reconciled } = await boot(root)
    expect(hookCalls).toEqual(['enable:hooked'])

    // Wiring what is already wired is a no-op.
    await Effect.runPromise(host.wire(reconciled.loaded))
    expect(hookCalls).toEqual(['enable:hooked'])

    await Effect.runPromise(host.release(hooked.id))
    expect(hookCalls).toEqual(['enable:hooked', 'disable:hooked'])
    expect((await rowById(hooked.id))?.status).toBe('enabled')
  })

  it('a throwing onEnable degrades that plugin with its message, and the others run', async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'echo')
    writeBundle(root, 'hooked', { hooks: hooks('hooked') })
    writeBundle(root, 'refuser', {
      hooks:
        "  onEnable: () => { throw new Error('the provider refused the webhook') },",
    })
    const echo = await row('echo')
    const hooked = await row('hooked')
    const refuser = await row('refuser')
    const { host, enqueue, wired } = await boot(root)

    expect(wired.map((v) => [v.id, v.status, v.reason])).toEqual([
      ['echo', 'enabled', null],
      ['hooked', 'enabled', null],
      [
        'refuser',
        'degraded',
        'onEnable failed: the provider refused the webhook',
      ],
    ])
    expect(await rowById(refuser.id)).toMatchObject({
      status: 'degraded',
      lastError: 'onEnable failed: the provider refused the webhook',
    })
    expect(host.granted(refuser.id, 'ping')).toBeNull()
    expect(hookCalls).toEqual(['enable:hooked'])

    expect(
      (
        await Effect.runPromiseExit(
          host.invoke(echo.id, 'enrich', { entityId: companyId }),
        )
      )._tag,
    ).toBe('Success')
    expect(
      (
        await Effect.runPromiseExit(
          host.invoke(hooked.id, 'ping', { entityId: companyId }),
        )
      )._tag,
    ).toBe('Success')
    expect(enqueue.built).toBe(1)
  })

  it('a failing onDisable still releases, and degrades that plugin with its message', async () => {
    const root = newPluginsRoot()
    writeBundle(root, 'stubborn', {
      hooks:
        "  onDisable: () => Effect.fail(new Error('could not unregister the webhook')),",
    })
    const stubborn = await row('stubborn')
    const { host } = await boot(root)
    expect(host.granted(stubborn.id, 'ping')).toEqual(['Log'])

    const released = await Effect.runPromise(host.release(stubborn.id))
    expect(released).toMatchObject({
      status: 'degraded',
      reason: 'onDisable failed: could not unregister the webhook',
    })
    expect(host.granted(stubborn.id, 'ping')).toBeNull()
    expect(await rowById(stubborn.id)).toMatchObject({
      status: 'degraded',
      lastError: 'onDisable failed: could not unregister the webhook',
    })
  })
})
