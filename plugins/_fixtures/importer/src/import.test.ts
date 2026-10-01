import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { testPorts } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin, { domainOf } from './index.ts'

/**
 * The importer's `importDeck` job on the SDK's test Layers (sdk-8): no
 * database, no network, no blob store. The snapshot is the job's whole
 * conversation with the host — every port call in order, with what each
 * returned; `ContentTest` records the stream as its presence, never its
 * bytes. What the live port does with those bytes is apps/worker's
 * `importer-live.test.ts`, on the real bundle over a test database.
 */
const FILENAME = 'acme-fusion.example__series-a-deck.pdf'
const pdf = readFileSync(new URL(`../fixtures/${FILENAME}`, import.meta.url))

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

const run = (ports: ReturnType<typeof testPorts>, filename: string) =>
  Effect.runPromiseExit(
    plugin.jobs
      .importDeck({
        stream: streamOf(new Uint8Array(pdf)),
        filename,
        mime: 'application/pdf',
      })
      .pipe(Effect.provide(ports.layer)),
  )

describe('the importer importDeck job, on the test Layers', () => {
  it('resolves the company the filename names and files the deck against it', async () => {
    const ports = testPorts({
      known: { 'entity-acme': { domain: 'acme-fusion.example' } },
    })
    const exit = await run(ports, FILENAME)
    expect(exit._tag).toBe('Success')
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Identity.resolve',
      'Content.fileDocument',
      'Log.info',
    ])
    const filed = ports.content.calls.at(0)
    expect(filed?.input).toMatchObject({
      body: { stream: '<stream>' },
      fileAgainst: [{ kind: 'record', entityId: 'entity-acme' }],
    })
    expect(ports.calls).toMatchSnapshot()
  })

  it('files a name it cannot read a domain from unfiled, resolving nothing', async () => {
    const ports = testPorts()
    const exit = await run(ports, 'series-a-deck.pdf')
    expect(exit._tag).toBe('Success')
    expect(ports.identity.calls).toEqual([])
    expect(ports.content.calls.at(0)?.input).toMatchObject({
      fileAgainst: [],
    })
  })
})

describe('domainOf', () => {
  it('reads the head before the separator, when it is a domain', () => {
    expect(domainOf(FILENAME)).toBe('acme-fusion.example')
    expect(domainOf('Acme-Fusion.Example__deck.pdf')).toBe(
      'acme-fusion.example',
    )
    expect(domainOf('deck.pdf')).toBeNull()
    expect(domainOf('__deck.pdf')).toBeNull()
    expect(domainOf('not a domain__deck.pdf')).toBeNull()
  })
})
