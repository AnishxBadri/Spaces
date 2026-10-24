import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `job_run` has exactly one writer, `runJob`, so every job inherits the row
 * instead of instrumenting itself. A second writer would break "one row per
 * attempt". Scans source text (no database) and names the offending file.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** The only file allowed to write the table, relative to the repo root. */
const THE_WRITER = 'apps/worker/src/run-job.ts'

/**
 * This file quotes the table name to do its job, and it is the scanner, not a
 * writer. Skipping it by path is honest; the alternative — spelling the
 * needles so they cannot match themselves — hides what is being looked for.
 */
const SELF = relative(repoRoot, fileURLToPath(import.meta.url))

/**
 * Both halves of a write. The drizzle spellings are what a TypeScript writer
 * would use; the SQL ones catch a raw statement, which is how a "just this
 * once" insert usually arrives.
 */
const WRITES: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: 'drizzle insert', pattern: /\.insert\(\s*jobRun\b/ },
  { what: 'drizzle update', pattern: /\.update\(\s*jobRun\b/ },
  { what: 'drizzle delete', pattern: /\.delete\(\s*jobRun\b/ },
  { what: 'sql insert', pattern: /insert\s+into\s+"?job_run"?/i },
  { what: 'sql update', pattern: /update\s+"?job_run"?\s+set/i },
  { what: 'sql delete', pattern: /delete\s+from\s+"?job_run"?/i },
]

function sourceFiles(dir: string): Array<string> {
  const out: Array<string> = []
  let entries: Array<string>
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

function scanRoots(): Array<string> {
  // Every app and every package: a second writer could appear in any of them.
  const roots: Array<string> = []
  for (const group of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(repoRoot, group))) {
      roots.push(join(repoRoot, group, pkg, 'src'))
    }
  }
  return roots
}

describe('job_run', () => {
  it('is written by runJob and by nothing else', () => {
    const offenders: Array<string> = []
    for (const root of scanRoots()) {
      for (const file of sourceFiles(root)) {
        const path = relative(repoRoot, file)
        if (path === THE_WRITER || path === SELF) continue
        const text = readFileSync(file, 'utf8')
        for (const { what, pattern } of WRITES) {
          if (pattern.test(text)) offenders.push(`${path} (${what})`)
        }
      }
    }
    expect(
      offenders,
      `job_run is written outside ${THE_WRITER}. The row belongs to runJob: declare what the job is about with JobDef.refs and let the wrapper write it`,
    ).toEqual([])
  })

  it('finds the writer it is guarding, so a rename cannot silently disarm it', () => {
    const text = readFileSync(join(repoRoot, THE_WRITER), 'utf8')
    expect(WRITES.some(({ pattern }) => pattern.test(text))).toBe(true)
  })

  it('scans more than one package', () => {
    const roots = scanRoots().filter((r) => sourceFiles(r).length > 0)
    expect(roots.length).toBeGreaterThan(1)
  })
})
