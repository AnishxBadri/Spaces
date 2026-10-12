import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * "Never written automatically" (D59), held by grep: a `supersedes` link is
 * written only behind a verb a person chose. Every module that reaches the
 * writer is listed with the act that calls it; a new caller fails this test
 * until it is added below with its reason. A model, intake or a plugin may
 * only propose (`proposeNewerVersionProgram`), which writes a suggestion.
 */

const SRC = join(import.meta.dirname, '..', '..')
const ROOT = join(SRC, '..', '..', '..')
const CORE = join(ROOT, 'packages', 'core', 'src')
const WORKER = join(ROOT, 'apps', 'worker', 'src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Any reference to the writer, and any hand-spelled supersedes row. */
const WRITES =
  /\binsertSupersedes\b|\bmarkNewerVersion(?:Program|InTx)\b|relation:\s*'supersedes'|'supersedes'::link_relation/

function walk(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

const matching = (pattern: RegExp) =>
  [
    ...walk(SRC).map((f) => [f, relative(SRC, f)] as const),
    ...walk(CORE).map((f) => [f, `core:${relative(CORE, f)}`] as const),
    ...walk(WORKER).map((f) => [f, `worker:${relative(WORKER, f)}`] as const),
  ]
    .filter(([f]) => pattern.test(readFileSync(f, 'utf8')))
    .map(([, name]) => name)
    .sort()

describe('no supersedes link without a user action', () => {
  it('only the known modules reach the supersedes writer', () => {
    expect(matching(WRITES)).toEqual([
      // The accept switch: a person pressing "Mark as newer version".
      'core:writes/links/supersedes.ts',
      'lib/ai/propose.ts',
      // "Save as new version" on a note.
      'lib/notes/new-version.ts',
      // `markNewerVersion`: "Newer version of…" and the upload pick.
      'lib/server/versions.ts',
    ])
  })

  it('markNewerVersion is called from the two pickers a person drives', () => {
    expect(matching(/\bmarkNewerVersion\(/)).toEqual([
      'components/files/newer-version-dialog.tsx',
      'components/files/newer-version-select.tsx',
    ])
    expect(matching(/\bsaveNoteAsNewVersion\(/)).toEqual([
      'routes/_app/notes_.$noteId.tsx',
    ])
  })

  it('accept reaches the writer from its one supersedes branch, and only a person accepts', () => {
    const src = read('lib/ai/propose.ts')
    expect(src.match(/row\.kind === 'supersedes'/g)).toHaveLength(1)
    expect(src.match(/markNewerVersionInTx\(/g)).toHaveLength(1)
    expect(src.match(/acceptSupersedesInTx\(/g)).toHaveLength(2)
    expect(src).toContain('if (!isPerson(actor))')
  })

  it('intake proposes and never links', () => {
    const proposer = readFileSync(
      join(CORE, 'writes', 'documents', 'newer-version.ts'),
      'utf8',
    )
    expect(proposer).toContain('proposeProgram(')
    expect(proposer).not.toMatch(/\.insert\(\s*link\s*\)/)
    const intake = readFileSync(
      join(CORE, 'writes', 'documents', 'intake.ts'),
      'utf8',
    )
    expect(intake).toContain('proposeNewerVersionProgram(')
  })
})
