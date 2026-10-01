import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, integration, link, note } from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { ReadLive } from '@spaces/core/writes/ports/read'
import type { ActionInput, JobError, PortService } from '@spaces/sdk'
import {
  FactsTest,
  HttpTest,
  IdentityTest,
  LogTest,
  ReadTest,
  ReceiptsTest,
  makeRecorder,
  readEntity,
} from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { reconcilePlugins } from './loader'

/**
 * `ReadTest` and `ReadLive` are one interface (sdk-6b): the echo fixture's
 * `enrich` job — the real bundle, loaded by the loader exactly as boot loads
 * it — runs once on the SDK's test Layers and once with `Read` swapped for
 * the live port over the test database. Both runs make the same port calls
 * and send the provider the same domain. The live run's record has a
 * private note linked to it; the job never sees its body.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const PROVIDER_URL = 'https://provider.example/v1/organizations/enrich'
const DOMAIN = 'northwind-robotics.example'
const url = `${PROVIDER_URL}?domain=${DOMAIN}`
const organization: unknown = JSON.parse(
  readFileSync(path.join(fixtures, 'echo/fixtures/organization.json'), 'utf8'),
)

type EnrichServices = PortService<
  'Read' | 'Http' | 'Identity' | 'Receipts' | 'Facts' | 'Log'
>
type EnrichRun = (
  input: ActionInput,
) => Effect.Effect<void, JobError, EnrichServices>

/** The loaded job is `unknown` until sdk-12b wires it; this is its shape. */
const isEnrich = (job: unknown): job is { run: EnrichRun } =>
  typeof job === 'object' &&
  job !== null &&
  'run' in job &&
  typeof job.run === 'function'

const loadEcho = async () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-readlive-')),
    'plugins',
  )
  const dir = path.join(root, 'echo', 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(path.join(fixtures, 'echo', 'dist', file), path.join(dir, file))
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'echo', version: '0.1.0', enabled: true })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root }),
  )
  const enrich = loaded.at(0)?.jobs.enrich
  if (!isEnrich(enrich)) throw new Error('echo has no enrich job')
  return { row, run: enrich.run }
}

/** Everything but Read, on the SDK's test Layers, over one recorder. */
const otherPorts = () => {
  const recorder = makeRecorder()
  const http = HttpTest(
    [{ url, response: { body: JSON.parse(JSON.stringify(organization)) } }],
    { recorder },
  )
  return {
    recorder,
    http,
    layer: Layer.mergeAll(
      IdentityTest({ recorder }).layer,
      ReceiptsTest({ recorder }).layer,
      FactsTest({ recorder }).layer,
      http.layer,
      LogTest({ recorder }).layer,
    ),
  }
}

const seedCompany = async () => {
  const company = await resolveEntity({
    kind: 'company',
    name: 'Northwind Robotics',
    keys: { domain: `https://www.${DOMAIN}/` },
    source: { class: 'manual' },
  })
  const privateNote = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: 'Northwind diligence' })
      .returning({ id: entity.id })
  ).at(0)
  if (!privateNote) throw new Error('no note')
  await db.insert(note).values({
    entityId: privateNote.id,
    title: 'Northwind diligence',
    bodyMd: 'Partner-only: the founders are talking to Sequoia.',
    authorId: FIXTURE_ACTOR.id,
    visibility: 'private',
  })
  await db.insert(link).values({
    fromEntityId: privateNote.id,
    toEntityId: company.entityId,
    relation: 'mentions',
  })
  return company.entityId
}

const traceOf = (calls: ReadonlyArray<{ port: string; method: string }>) =>
  calls.map((c) => `${c.port}.${c.method}`)

describe('the echo enrich job, on ReadTest and on ReadLive', () => {
  it('makes the same calls and sends the same domain through either Read', async () => {
    const companyId = await seedCompany()
    const { row, run } = await loadEcho()

    // 1. ReadTest — the record as the fixture's own test describes it.
    const fake = otherPorts()
    const readTest = ReadTest({
      entities: [
        readEntity({
          id: companyId,
          name: 'Northwind Robotics',
          keys: { domain: [DOMAIN], email: [], linkedin: [], cin: [] },
        }),
      ],
      recorder: fake.recorder,
    })
    const fakeExit = await Effect.runPromiseExit(
      run({ entityId: companyId }).pipe(
        Effect.provide(Layer.merge(readTest.layer, fake.layer)),
      ),
    )
    expect(fakeExit._tag).toBe('Success')

    // 2. ReadLive — the same record, read from the database as the row.
    const live = otherPorts()
    const liveExit = await Effect.runPromiseExit(
      run({ entityId: companyId }).pipe(
        Effect.provide(Layer.merge(ReadLive(row), live.layer)),
      ),
    )
    expect(liveExit._tag).toBe('Success')

    const expected = [
      'Http.request',
      'Identity.resolve',
      'Receipts.store',
      'Facts.fill',
      'Log.info',
    ]
    expect(traceOf(fake.recorder.calls)).toEqual(['Read.entity', ...expected])
    // ReadLive is not on the recorder; the rest of the run is identical.
    expect(traceOf(live.recorder.calls)).toEqual(expected)
    expect(live.http.calls.at(0)?.input).toEqual(fake.http.calls.at(0)?.input)
    expect(live.http.calls.at(0)?.input).toMatchObject({ url })
    expect(JSON.stringify(live.recorder.calls)).not.toContain('Sequoia')
  })
})
