import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A window's width is its `size`, never one the caller spells: no
 * `max-w-` on a `DialogContent` call. Two exceptions are kept, each with a
 * comment naming itself one: the attribute window (one fixed height for
 * every type) and Cmd-K (it owns its size and widens for its preview).
 */

const SRC = fileURLToPath(new URL('../..', import.meta.url))

const EXCEPTIONS = new Set([
  'components/attributes/attribute-dialog.tsx',
  'components/ui/command.tsx',
])

function sources(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.')
      ? [path]
      : []
  })
}

/** The opening tag starting at `at`, braces and strings balanced. */
function openingTag(text: string, at: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = at; i < text.length; i++) {
    const c = text[i]
    if (quote !== null) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return text.slice(at, i + 1)
  }
  throw new Error(`unclosed <DialogContent at ${at}`)
}

const calls = sources(SRC).flatMap((path) => {
  const text = readFileSync(path, 'utf8')
  const file = relative(SRC, path)
  return [...text.matchAll(/<DialogContent\b/g)].map((m) => ({
    file,
    tag: openingTag(text, m.index),
    before: text.slice(Math.max(0, m.index - 300), m.index),
  }))
})

describe('window widths', () => {
  it('finds the windows it guards', () => {
    expect(calls.length).toBeGreaterThan(30)
  })

  it('every DialogContent call names its size', () => {
    const unsized = calls.filter((c) => !/\bsize=/.test(c.tag))
    expect(unsized.map((c) => c.file)).toEqual([])
  })

  it('no DialogContent call spells a width, outside the two exceptions', () => {
    const spelled = calls.filter(
      (c) => /max-w-/.test(c.tag) && !EXCEPTIONS.has(c.file),
    )
    expect(spelled.map((c) => `${c.file}: ${c.tag}`)).toEqual([])
  })

  it('each exception says it is one', () => {
    for (const file of EXCEPTIONS) {
      const call = calls.find((c) => c.file === file)
      expect(call, file).toBeDefined()
      expect(call?.before, file).toMatch(/size exception/i)
    }
  })
})
