import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ROLE_PREFIXES } from './normalize.ts'

/**
 * One role-prefix list. "A role email never identifies a person" is only one
 * rule while it is one list: a second copy in core or the SDK would drift,
 * and the plugin and the choke point would disagree about who is a person.
 *
 * A second list is a source file, other than normalize.ts, spelling four or
 * more of the prefixes as string literals. apps/web's `ROLE_SENDERS` is out
 * of scope on purpose: it filters mail noise, a different job.
 */
const packagesDir = fileURLToPath(new URL('../../../', import.meta.url))
const HOME = 'sdk/src/identity/normalize.ts'

const sources = ['core/src', 'sdk/src'].flatMap((dir) =>
  readdirSync(`${packagesDir}${dir}`, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
    .map((p) => `${dir}/${p}`),
)

describe('the role-prefix list', () => {
  it('is exported, and holds the prefixes the rule names', () => {
    for (const prefix of ['info', 'careers', 'support', 'sales']) {
      expect(ROLE_PREFIXES.has(prefix)).toBe(true)
    }
  })

  it('scans both packages', () => {
    expect(sources).toContain(HOME)
    expect(sources).toContain('core/src/writes/entities/resolve.ts')
  })

  it('exists once in packages/core and packages/sdk', () => {
    const copies = sources.filter((path) => {
      if (path === HOME) return false
      const text = readFileSync(`${packagesDir}${path}`, 'utf8')
      const spelled = [...ROLE_PREFIXES].filter(
        (p) => text.includes(`'${p}'`) || text.includes(`"${p}"`),
      )
      return spelled.length >= 4
    })
    expect(copies).toEqual([])
  })
})
