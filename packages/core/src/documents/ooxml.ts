import { strFromU8, unzipSync } from 'fflate'

/**
 * The OOXML container helpers, shared by the two readers that open one: the
 * pptx text path in `extract.ts` and the xlsx grid in `import/read.ts`
 * (SPA-163). This is the repo's only `unzipSync` call — a second xlsx or
 * pptx parser would have to come through here, which is where it would be
 * noticed.
 */

export type Zip = Record<string, Uint8Array>
export type ZipEntry = { path: string; n: number; xml: string }

export function unzip(bytes: Uint8Array): Zip {
  return unzipSync(bytes)
}

/** Decoded zip member, or undefined when the archive doesn't carry it. */
export function entry(zip: Zip, path: string): string | undefined {
  const bytes = Object.hasOwn(zip, path) ? zip[path] : undefined
  return bytes ? strFromU8(bytes) : undefined
}

/**
 * Zip entries matching a numbered-file pattern, in numeric order — slide10
 * sorts after slide9, which a lexical sort gets wrong.
 */
export function numbered(zip: Zip, pattern: RegExp): Array<ZipEntry> {
  return Object.entries(zip)
    .map(([path, bytes]) => {
      const m = path.match(pattern)
      return m ? { path, n: Number(m[1]), xml: strFromU8(bytes) } : null
    })
    .filter((x): x is ZipEntry => x !== null)
    .sort((a, b) => a.n - b.n)
}

/**
 * Text of every <tag>…</tag> run, entity-decoded, whitespace-only runs kept —
 * a cell's text is verbatim, so a lone-space run between two rich-text runs
 * is part of the value.
 */
export function allRuns(xml: string, tag: string): Array<string> {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  return [...xml.matchAll(pattern)].map((m) => decodeXml(m[1]))
}

/** Text of every <tag>…</tag> run, entity-decoded, whitespace-only runs dropped. */
export function ooxmlRuns(xml: string, tag: string): Array<string> {
  return allRuns(xml, tag).filter((t) => t.trim() !== '')
}

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

export function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return String.fromCodePoint(parseInt(code.slice(2), 16))
    }
    if (code.startsWith('#')) {
      return String.fromCodePoint(Number(code.slice(1)))
    }
    return ENTITIES.get(code) ?? whole
  })
}
