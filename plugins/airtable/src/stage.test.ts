import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { testPorts } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.ts'

/**
 * The `stage` job on the SDK's test Layers: no database, no blob store. Its
 * whole conversation with the host is one `Import.stage` and one log line;
 * what lands is `ImportTest`'s reading, which is the live port's. The live
 * port, the import wizard's routing and the preview are apps/worker's
 * `airtable-live.test.ts`.
 */

const FILENAME = 'Companies-Grid view.csv'
const bytesOf = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url))

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

const run = (ports: ReturnType<typeof testPorts>, bytes: Uint8Array) =>
  Effect.runPromiseExit(
    plugin.jobs
      .stage({ stream: streamOf(bytes), filename: FILENAME, mime: 'text/csv' })
      .pipe(Effect.provide(ports.layer)),
  )

/** The plain export's rows, as the plain CSV path would read them. */
const plainRows = () =>
  readFileSync(new URL('../fixtures/companies.csv', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .slice(1)

describe('the airtable stage job, on the test Layers', () => {
  it('stages the export as one grid and logs what it read', async () => {
    const ports = testPorts()
    const exit = await run(ports, new Uint8Array(bytesOf(FILENAME)))
    expect(exit._tag).toBe('Success')
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Import.stage',
      'Log.info',
    ])
    expect(ports.log.lines).toEqual([
      {
        level: 'info',
        message: 'staged',
        fields: {
          batchId: 'batch-1',
          staged: 30,
          malformed: 0,
          refused: 0,
          lists: ['Business model', 'Founders'],
          attachments: ['Deck'],
        },
      },
    ])
    expect(ports.import.columns).toHaveLength(8)
    expect(ports.import.rows).toHaveLength(plainRows().length)
  })

  it('lands each list as the cell Airtable wrote, and each attachment as its URL', async () => {
    const ports = testPorts()
    await run(ports, new Uint8Array(bytesOf(FILENAME)))
    expect(ports.import.rows.at(1)).toEqual({
      rowNum: 2,
      cells: [
        'Acme Fusion',
        'https://www.acme-fusion.example',
        'B2B,Marketplace',
        'Series A',
        'Boston, MA',
        '2021',
        'Leo Brandt,Mia Okafor',
        'https://dl.airtable.com/.attachments/att001/acme-fusion-deck.pdf',
      ],
      reason: null,
    })
  })

  it('fails permanently on a file with no header', async () => {
    const ports = testPorts()
    const exit = await run(ports, new TextEncoder().encode('\n'))
    expect(exit._tag).toBe('Failure')
    expect(ports.import.calls).toEqual([])
  })
})
