import { describe, expect, it } from 'vitest'
import { fileJobData, importReaderOf } from './dialect'

const manifest = (jobs: Record<string, unknown>) => ({
  manifestVersion: 1,
  id: 'airtable',
  version: '0.1.0',
  sdk: '^1.1',
  name: 'Airtable',
  description: 'Reads an Airtable CSV export.',
  settings: {},
  jobs,
})

const reader = {
  trigger: 'file',
  uses: ['Import', 'Log'],
  accepts: { filename: '-[^/]* view\\.csv$' },
}

describe('importReaderOf', () => {
  it('names the file job that uses Import and accepts the filename', () => {
    expect(
      importReaderOf(manifest({ stage: reader }), 'Companies-Grid View.CSV'),
    ).toEqual({
      pluginId: 'airtable',
      pluginName: 'Airtable',
      job: 'stage',
      queue: 'plugin.airtable.stage',
    })
  })

  it('offers nothing for a name it does not accept, a job without Import, or a broken manifest', () => {
    expect(importReaderOf(manifest({ stage: reader }), 'companies.csv')).toBe(
      null,
    )
    expect(
      importReaderOf(
        manifest({ stage: { ...reader, uses: ['Content'] } }),
        'Companies-Grid view.csv',
      ),
    ).toBe(null)
    expect(
      importReaderOf(
        manifest({ stage: { trigger: 'file', uses: ['Import'] } }),
        'Companies-Grid view.csv',
      ),
    ).toBe(null)
    expect(importReaderOf({ id: 'airtable' }, 'Companies-Grid view.csv')).toBe(
      null,
    )
  })
})

describe('fileJobData', () => {
  it('takes a digest, a name, a mime and an optional batch', () => {
    const blobSha = 'a'.repeat(64)
    expect(
      fileJobData.safeParse({ blobSha, filename: 'x.csv', mime: null }).success,
    ).toBe(true)
    expect(
      fileJobData.safeParse({
        blobSha: 'nope',
        filename: 'x.csv',
        mime: null,
      }).success,
    ).toBe(false)
  })
})
