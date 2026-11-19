import { describe, expect, it } from 'vitest'
import { parsePackageJson } from './versioning.ts'

/**
 * What the release scripts read from a package.json and what they refuse.
 * Every row was held against the zod shape before it was an Effect schema.
 */

const REFUSED = 'REFUSED'

const parsed = (text: string): unknown => {
  try {
    return parsePackageJson(text)
  } catch {
    return REFUSED
  }
}

const pkg = { name: '@spaces/plugin-echo', version: '1.2.0' }

type Row = readonly [label: string, text: string, out: unknown]

const rows: ReadonlyArray<Row> = [
  ['a name and a version', JSON.stringify(pkg), pkg],
  [
    'scripts',
    JSON.stringify({ ...pkg, scripts: { build: 'tsup', test: 'vitest' } }),
    { ...pkg, scripts: { build: 'tsup', test: 'vitest' } },
  ],
  [
    'the fields it does not read',
    JSON.stringify({ ...pkg, private: true, dependencies: { effect: '4' } }),
    pkg,
  ],
  [
    'no scripts',
    JSON.stringify({ ...pkg, scripts: {} }),
    { ...pkg, scripts: {} },
  ],
  [
    'a numeric script',
    JSON.stringify({ ...pkg, scripts: { build: 1 } }),
    REFUSED,
  ],
  ['scripts as a list', JSON.stringify({ ...pkg, scripts: ['tsup'] }), REFUSED],
  ['scripts null', JSON.stringify({ ...pkg, scripts: null }), REFUSED],
  [
    'a __proto__ script',
    `{"name":"x","version":"1.0.0","scripts":{"__proto__":"evil","build":"tsup"}}`,
    { name: 'x', version: '1.0.0', scripts: { build: 'tsup' } },
  ],
  ['no name', JSON.stringify({ version: '1.0.0' }), REFUSED],
  ['a numeric version', JSON.stringify({ name: 'x', version: 1 }), REFUSED],
  [
    'an empty version',
    JSON.stringify({ name: 'x', version: '' }),
    { name: 'x', version: '' },
  ],
  ['a list', '[]', REFUSED],
  ['not JSON', '{', REFUSED],
]

describe('parsePackageJson', () => {
  it.each(rows)('%s', (_, text, out) => {
    expect(parsed(text)).toEqual(out)
  })
})
