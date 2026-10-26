import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every printed date goes through `@spaces/core/format`: no `MM-DD` cut
 * out of an ISO string, no `HH:MM` cut out of one, and no `Intl` date
 * formatter, whose output differs between Node and the browser.
 * - A day sliced as a key or compared lexically (`.slice(0, 10)`) is fine
 *   and is not looked at.
 */

const web = fileURLToPath(new URL('..', import.meta.url))
const core = fileURLToPath(
  new URL('../../../../packages/core/src', import.meta.url),
)

function sourceFiles(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : []
  })
}

/** `x.slice(5, 10)` or `x.slice(11, 16)` (and `x.slice(5)` on a day). */
const CUT = /([\w$]+)(?:\(\))?\??\.slice\(\s*(5\s*,\s*10|11\s*,\s*16|5)\s*\)/g

/** A receiver named for a date: `createdAt`, `due`, `today`, `toISOString()`. */
const DATE_NAMED =
  /(at|on|date|day|due|iso|time|today|since|eow|close|stamp|when|toisostring|totimestring)$/i

function cutsIn(file: string): Array<string> {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(CUT)]
    .filter((m) => DATE_NAMED.test(m[1]))
    .map((m) => `${relative(web, file)}: ${m[0]}`)
}

describe('printed dates', () => {
  it('never cuts MM-DD or HH:MM out of an ISO string in apps/web/src', () => {
    expect(sourceFiles(web).flatMap(cutsIn)).toEqual([])
  })

  it('finds a cut when one is written', () => {
    const sample = 'const a = row.createdAt.slice(5, 10) + iso.slice(11, 16)'
    expect([...sample.matchAll(CUT)].map((m) => m[1])).toEqual([
      'createdAt',
      'iso',
    ])
    expect(DATE_NAMED.test('filename')).toBe(false)
  })

  it('formats no date through Intl in apps/web/src or packages/core', () => {
    const intl = /Intl\.DateTimeFormat|toLocale(?:Date|Time)String/
    const hits = [...sourceFiles(web), ...sourceFiles(core)].filter((f) =>
      intl.test(readFileSync(f, 'utf8')),
    )
    expect(hits.map((f) => relative(web, f))).toEqual([])
  })
})
