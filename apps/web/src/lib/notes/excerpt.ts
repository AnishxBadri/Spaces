import { excerpt } from '@spaces/core/context/excerpt'

/** How much of a body an excerpt reads. */
const EXCERPT_CHARS = 160

/**
 * A note's excerpt: its body with the markdown marks stripped, cut at
 * `EXCERPT_CHARS`; null for a body with no words.
 */
export function noteExcerpt(bodyMd: string): string | null {
  const plain = bodyMd
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, ' ')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
  const text = excerpt(plain, { noteBody: true, max: EXCERPT_CHARS })
  return text === '' ? null : text
}
