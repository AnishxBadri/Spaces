/**
 * Splits a plugin migration file into its statements on top-level `;`, so
 * each runs alone and a failure names the statement that failed.
 *
 * - Skips `;` inside '…' (and E'…' with backslash escapes), "…", $tag$…$tag$,
 *   `--` comments and nested block comments.
 * - A piece holding only comments and whitespace is not a statement, and a
 *   statement starts at its first character of code (leading comments go).
 */
export const splitStatements = (text: string): ReadonlyArray<string> => {
  const statements: Array<string> = []
  const n = text.length
  let start = 0
  let hasCode = false
  let i = 0

  const cut = (end: number) => {
    if (hasCode) statements.push(text.slice(start, end).trim())
    hasCode = false
  }
  const isIdent = (ch: string | undefined) =>
    ch !== undefined && /[A-Za-z0-9_$]/.test(ch)

  /** The index just past a quoted run opened at `open`. */
  const pastQuoted = (open: number, quote: string, escapes: boolean) => {
    let j = open + 1
    while (j < n) {
      const ch = text[j]
      if (escapes && ch === '\\') {
        j += 2
      } else if (ch === quote) {
        if (text[j + 1] !== quote) return j + 1
        j += 2
      } else {
        j += 1
      }
    }
    return n
  }

  while (i < n) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '-' && next === '-') {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? n : newline + 1
      continue
    }
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (text.startsWith('/*', i)) {
          depth += 1
          i += 2
        } else if (text.startsWith('*/', i)) {
          depth -= 1
          i += 2
        } else {
          i += 1
        }
      }
      continue
    }
    if (ch === ';') {
      cut(i)
      i += 1
      continue
    }
    if (!hasCode && !/\s/.test(ch)) {
      hasCode = true
      start = i
    }
    if (ch === "'") {
      const prefix = text[i - 1]
      const escapes =
        (prefix === 'E' || prefix === 'e') && !isIdent(text[i - 2])
      i = pastQuoted(i, "'", escapes)
      continue
    }
    if (ch === '"') {
      i = pastQuoted(i, '"', false)
      continue
    }
    if (ch === '$' && !isIdent(text[i - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))?.at(0)
      if (tag !== undefined) {
        const close = text.indexOf(tag, i + tag.length)
        i = close === -1 ? n : close + tag.length
        continue
      }
    }
    i += 1
  }
  cut(n)
  return statements
}
