import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * SPA-94: **vision is the only sanctioned direct AI write to a document.**
 *
 * Everything else the AI does ends in a `suggestion` row a person accepts
 * (docs/spec-ai-substrate.md §10, §11; CONTEXT.md, D41). The exception is
 * the vision lane, because it _is_ extraction: a scanned PDF's pages read by
 * a model become `extracted_text` and `tsv` exactly as a text layer would.
 * This grep holds the exception to that one tenant, so the next reader who
 * wants a model to write a document's text finds this test first:
 *
 *   - the statements that write `document.extracted_text` are extraction's
 *     own — the extract job, the URL clip, and the dev seed — and none of
 *     those files calls a model;
 *   - the one file that both calls a model and writes a document's text is
 *     `worker/jobs/vision-document.ts`, and it writes it through
 *     extraction's statement (`ExtractionStore.markExtracted`), naming no
 *     column of `document` itself.
 */

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

function sources(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name)
    if (d.isDirectory()) return sources(path)
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [path] : []
  })
}

const files = sources(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}))

/** A statement against the `document` table that sets `extracted_text`. */
const writesText = (text: string): boolean =>
  (/\.(update|insert)\(document\)/.test(text) &&
    /\bextractedText\s*:\s*(?!string\b)/.test(text)) ||
  /\bextracted_text\s*=/.test(text)

/** Reaches a language model: `complete()`, the extraction cache, or the SDK. */
const callsModel = (text: string): boolean =>
  /\b(completeProgram|cachedExtractProgram|generateText|generateObject|streamText)\(/.test(
    text,
  )

/** Writes through extraction's own statement. */
const marksExtracted = (text: string): boolean => /\.markExtracted\(/.test(text)

describe('vision is the only sanctioned direct AI write to a document', () => {
  it('the statements that write extracted_text are extraction’s, and none calls a model', () => {
    const writers = files.filter((f) => writesText(f.text))
    expect(writers.map((f) => f.path).sort()).toEqual([
      'lib/seeds/dev.ts',
      'worker/jobs/clip-document.ts',
      'worker/jobs/extract-document.ts',
    ])
    expect(writers.filter((f) => callsModel(f.text))).toEqual([])
  })

  it('the one file that calls a model and writes a document’s text is the vision job', () => {
    const aiWriters = files
      .filter((f) => callsModel(f.text))
      .filter((f) => writesText(f.text) || marksExtracted(f.text))
      .map((f) => f.path)
    expect(aiWriters).toEqual(['worker/jobs/vision-document.ts'])
  })

  it('and it writes through extraction’s statement, naming no document column', () => {
    const vision = files.find(
      (f) => f.path === 'worker/jobs/vision-document.ts',
    )
    expect(vision).toBeDefined()
    expect(vision?.text).toMatch(/store\.markExtracted\(/)
    expect(vision?.text).toMatch(/store\.onExtracted\(/)
    expect(vision?.text).not.toMatch(/\.(update|insert)\(document\)/)
  })
})
