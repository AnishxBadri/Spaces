import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * A recorded cassette: a provider's answers, committed beside the plugin at
 * `plugins/<id>/fixtures/cassette/cassette.json`, matched on method and URL.
 *
 * - Exact URLs win over wildcard ones. A query value of `*` matches any
 *   value, and the response file's `{{name}}` is that value, JSON-escaped.
 * - A request no interaction matches answers 404 naming it — never the
 *   network.
 * - `keyHeader` is where the provider reads its key; `revoked` is what it
 *   answers a key that has been revoked (`makeFakeProvider`).
 */

const response = z.object({
  status: z.int().min(100).max(599),
  /** Relative to the plugin's `fixtures/`. */
  file: z.string().min(1),
})

const interaction = response.extend({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.url(),
})

const cassetteFile = z.object({
  keyHeader: z.string().min(1),
  interactions: z.array(interaction).min(1),
  revoked: response.optional(),
})

export type Recorded = {
  readonly status: number
  readonly body: string
}

export type Cassette = {
  /** Lower-case: where the provider reads its key. */
  readonly keyHeader: string
  readonly match: (method: string, url: string) => Recorded | null
  readonly revoked: Recorded
}

/** What a provider with no `revoked` entry answers a revoked key. */
const REVOKED: Recorded = {
  status: 401,
  body: JSON.stringify({ error: 'invalid api key' }),
}

type Compiled = {
  readonly method: string
  readonly base: string
  readonly query: ReadonlyMap<string, string>
  readonly wildcard: boolean
  readonly status: number
  readonly template: string
}

const splitUrl = (url: string) => {
  const parsed = new URL(url)
  return {
    base: `${parsed.origin}${parsed.pathname}`,
    query: new Map(parsed.searchParams),
  }
}

/** The captured `*` values, or null when `request` is not this interaction's URL. */
const captures = (
  entry: Compiled,
  base: string,
  query: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> | null => {
  if (entry.base !== base || entry.query.size !== query.size) return null
  const captured = new Map<string, string>()
  for (const [name, expected] of entry.query) {
    const actual = query.get(name)
    if (actual === undefined) return null
    if (expected === '*') captured.set(name, actual)
    else if (expected !== actual) return null
  }
  return captured
}

const splice = (
  template: string,
  values: ReadonlyMap<string, string>,
): string =>
  template.replace(/\{\{([\w-]+)\}\}/g, (whole, name: string) => {
    const value = values.get(name)
    return value === undefined ? whole : JSON.stringify(value).slice(1, -1)
  })

/** Reads and compiles `<fixturesDir>/cassette/cassette.json`; throws naming what is wrong. */
export const loadCassette = (fixturesDir: string): Cassette => {
  const file = path.join(fixturesDir, 'cassette', 'cassette.json')
  const parsed = cassetteFile.parse(JSON.parse(readFileSync(file, 'utf8')))
  const read = (name: string) =>
    readFileSync(path.join(fixturesDir, name), 'utf8')
  const compiled: ReadonlyArray<Compiled> = parsed.interactions
    .map((entry) => {
      const { base, query } = splitUrl(entry.url)
      return {
        method: entry.method,
        base,
        query,
        wildcard: [...query.values()].includes('*'),
        status: entry.status,
        template: read(entry.file),
      }
    })
    // Exact interactions first; within each group, the file's order.
    .sort((a, b) => Number(a.wildcard) - Number(b.wildcard))

  return {
    keyHeader: parsed.keyHeader.toLowerCase(),
    revoked:
      parsed.revoked === undefined
        ? REVOKED
        : { status: parsed.revoked.status, body: read(parsed.revoked.file) },
    match: (method, url) => {
      const { base, query } = splitUrl(url)
      for (const entry of compiled) {
        if (entry.method !== method) continue
        const values = captures(entry, base, query)
        if (values !== null)
          return { status: entry.status, body: splice(entry.template, values) }
      }
      return null
    },
  }
}
