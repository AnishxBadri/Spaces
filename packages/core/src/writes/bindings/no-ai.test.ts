import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A bound folder's filing never calls a model: `resolveItem`, its kind
 * dictionary and the sync walk import nothing under an `ai` namespace.
 * Storage sources deliver bytes; the extraction event fires the AI features
 * (spec-ai-substrate §11). A grep over each module's import specifiers.
 * - The sensitivity stamp is the one exception: a chunk flag written in the
 *   filing's transaction, never a model call.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url))

const FILES = [
  'documents/resolve-item.ts',
  'documents/index.ts',
  'writes/bindings/sync.ts',
  'writes/bindings/poll.ts',
  'writes/bindings/move.ts',
]

/** Under `ai`, and allowed: a stamp, not a model. */
const STAMP = '../ai/stamp-sensitivity'

/** Every `from '…'` and `import('…')` specifier in a module. */
const specifiers = (text: string): Array<string> =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  )

/** `ai` as a path segment: `../ai/x`, `@spaces/core/ai/x`, `#/lib/ai`. */
const AI_SEGMENT = /(^|\/)ai(\/|$)/

describe('the filing path imports nothing under ai', () => {
  it.each(FILES)('%s', (file) => {
    const found = specifiers(readFileSync(SRC + file, 'utf8'))
    expect(found.filter((s) => AI_SEGMENT.test(s) && s !== STAMP)).toEqual([])
  })

  it('the needle finds what it is for', () => {
    expect(
      specifiers(
        `import { x } from '../ai/lanes'\nconst y = await import('@spaces/core/ai/schema')`,
      ).filter((s) => AI_SEGMENT.test(s)),
    ).toEqual(['../ai/lanes', '@spaces/core/ai/schema'])
  })
})
