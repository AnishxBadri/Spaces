import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { enrichmentRunData } from '@spaces/core/enrichment/auto'
import { fileJobData } from '@spaces/core/import/dialect'
import { watchRunData } from '@spaces/core/queue/watch'
import { decodeJobData } from '../job-data'

/**
 * The payloads core declares for the worker's queues, through the one decode
 * every job takes at its entry. Every row was held against the zod shapes
 * before they were Effect schemas, so a row that moves is a payload some
 * queue already sends that a job would now treat differently.
 */

const REFUSED = 'refused'

type Row = readonly [label: string, input: unknown, expected: unknown]

const U = 'a3bb189e-8bf9-4888-9912-ace4e6543002'
const U2 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SHA = '0123456789abcdef'.repeat(4)

/** A payload's verdict: what the job is handed, or `REFUSED`. */
const verdictOf = (decoded: Result.Result<unknown, string>): unknown =>
  Result.isSuccess(decoded) ? decoded.success : REFUSED

const table: ReadonlyArray<
  readonly [string, (input: unknown) => unknown, ReadonlyArray<Row>]
> = [
  [
    'enrichmentRunData',
    (input: unknown) => verdictOf(decodeJobData(enrichmentRunData, input)),
    [
      [
        'the Enrich button',
        { entityId: U, reason: 'Enrich' },
        { entityId: U, reason: 'Enrich' },
      ],
      [
        'an auto run',
        {
          entityId: U,
          reason: 'Auto-enrich · filed',
          trigger: 'filed',
          sources: [U2],
        },
        {
          entityId: U,
          reason: 'Auto-enrich · filed',
          trigger: 'filed',
          sources: [U2],
        },
      ],
      [
        'a parked bulk run',
        { entityId: U, reason: 'x', parkedBy: U2, bulk: true },
        { entityId: U, reason: 'x', parkedBy: U2, bulk: true },
      ],
      [
        'sources undefined',
        { entityId: U, reason: 'x', sources: undefined },
        { entityId: U, reason: 'x', sources: undefined },
      ],
      [
        'a stray key',
        { entityId: U, reason: 'x', at: 1 },
        { entityId: U, reason: 'x' },
      ],
      ['no sources', { entityId: U, reason: 'x', sources: [] }, REFUSED],
      ['bulk false', { entityId: U, reason: 'x', bulk: false }, REFUSED],
      [
        'an unknown trigger',
        { entityId: U, reason: 'x', trigger: 'x' },
        REFUSED,
      ],
      ['null', null, REFUSED],
    ],
  ],
  [
    'fileJobData',
    (input: unknown) => verdictOf(decodeJobData(fileJobData, input)),
    [
      [
        'a dropped file',
        { blobSha: SHA, filename: 'a.csv', mime: null, batchId: U },
        { blobSha: SHA, filename: 'a.csv', mime: null, batchId: U },
      ],
      [
        'a stray key',
        { blobSha: SHA, filename: 'a', mime: 'x', n: 1 },
        { blobSha: SHA, filename: 'a', mime: 'x' },
      ],
      ['no type', { blobSha: SHA, filename: 'a' }, REFUSED],
      ['a bad digest', { blobSha: 'x', filename: 'a', mime: null }, REFUSED],
      ['null', null, REFUSED],
    ],
  ],
  [
    'watchRunData',
    (input: unknown) => verdictOf(decodeJobData(watchRunData, input)),
    [
      ['a run', { watchId: U, spaceId: U2 }, { watchId: U, spaceId: U2 }],
      [
        'a stray key',
        { watchId: U, spaceId: U2, x: 1 },
        { watchId: U, spaceId: U2 },
      ],
      ['a bad watch', { watchId: 'x', spaceId: U2 }, REFUSED],
      ['null', null, REFUSED],
    ],
  ],
]

describe.each(table)('%s', (_name, verdict, rows) => {
  it.each(rows)('%s', (_label, input, expected) => {
    expect(verdict(input)).toStrictEqual(expected)
  })
})
