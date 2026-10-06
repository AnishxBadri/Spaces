import { Effect } from 'effect'
import type { Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { LogLive } from '@spaces/core/writes/ports/log'
import { Log } from '@spaces/sdk'
import { LogTest } from '@spaces/sdk/testing'
import { runOn } from './support'

/**
 * The Log port's contract, over every implementation: each call is one line
 * at its level carrying the message and the fields, and logging never fails
 * a job. (Scrubbing a bound key is the live Layer's, proved with the grant.)
 */

type Line = { readonly level: string; readonly text: string }

type LogImplementation = {
  readonly name: string
  readonly make: () => {
    readonly layer: Layer.Layer<Log>
    readonly lines: () => ReadonlyArray<Line>
  }
}

const IMPLEMENTATIONS: ReadonlyArray<LogImplementation> = [
  {
    name: 'LogLive',
    make: () => {
      const lines: Array<Line> = []
      return {
        layer: LogLive('conformance', {
          sink: (level, text) => {
            lines.push({ level, text })
          },
        }),
        lines: () => lines,
      }
    },
  },
  {
    name: 'LogTest',
    make: () => {
      const log = LogTest()
      return {
        layer: log.layer,
        lines: () =>
          log.lines.map((l) => ({
            level: l.level,
            text: `${l.message} ${JSON.stringify(l.fields)}`,
          })),
      }
    },
  },
]

describe.each(IMPLEMENTATIONS)('Log — $name', (impl) => {
  it('writes one line per call, at its level, with the message and the fields', async () => {
    const { layer, lines } = impl.make()
    await runOn(
      layer,
      Effect.gen(function* () {
        const log = yield* Log
        yield* log.info('enriched', { receiptId: 'r-1' })
        yield* log.warn('slow provider', { ms: 1200 })
        yield* log.error('gave up')
      }),
    )
    expect(lines().map((l) => l.level)).toEqual(['info', 'warn', 'error'])
    expect(lines()[0]?.text).toContain('enriched')
    expect(lines()[0]?.text).toContain('"receiptId":"r-1"')
    expect(lines()[1]?.text).toContain('"ms":1200')
    expect(lines()[2]?.text).toContain('gave up')
  })
})
