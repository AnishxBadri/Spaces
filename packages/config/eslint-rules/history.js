//  @ts-check

/**
 * `comments/no-history` — comments describe the current code, not its history.
 *
 * Rejects issue ids (`SPA-123`), decision ids (`D12`) and ISO dates in a
 * comment; the commit message is where those belong. Directive comments
 * (`eslint-disable`, `@ts-expect-error`, …) are skipped: their text is read
 * by a tool and is not prose. A date in backticks or quotes is an example
 * value and passes.
 */

/** @type {Array<{ pattern: RegExp, what: string, quotedOk?: true }>} */
const BANNED = [
  { pattern: /\bSPA-\d+\b/g, what: 'an issue id' },
  { pattern: /\bD\d{1,3}\b/g, what: 'a decision id' },
  // A quoted date is an example value (`2026-02-30`), not a timestamp.
  { pattern: /\b\d{4}-\d{2}-\d{2}\b/g, what: 'a date', quotedOk: true },
]

/** The comment with `code` and "quoted" spans blanked, offsets preserved. */
const unquoted = (/** @type {string} */ text) =>
  text.replace(/`[^`]*`|"[^"\n]*"/g, (span) => ' '.repeat(span.length))

const DIRECTIVE =
  /^\s*(eslint-disable|eslint-enable|eslint\s|global\s|globals\s|@ts-expect-error|@ts-ignore|@ts-nocheck|@ts-check|prettier-ignore|istanbul\s|c8\s|@vitest-environment|@jsx|\/\s*<reference|#__PURE__|@__PURE__|@vite-ignore)/

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow issue ids, decision ids and dates in comments; history belongs in the commit message.',
    },
    schema: [],
    messages: {
      history:
        'Comment carries {{what}} ({{token}}). Say what the code does and why; history belongs in the commit message.',
    },
  },
  create(context) {
    const source = context.sourceCode
    return {
      Program() {
        for (const comment of source.getAllComments()) {
          const text = comment.value.replace(/^\*+/, '')
          if (DIRECTIVE.test(text)) continue
          for (const { pattern, what, quotedOk } of BANNED) {
            const value = quotedOk ? unquoted(comment.value) : comment.value
            for (const match of value.matchAll(pattern)) {
              const start =
                /** @type {[number, number]} */ (comment.range)[0] +
                2 +
                (match.index ?? 0)
              context.report({
                loc: {
                  start: source.getLocFromIndex(start),
                  end: source.getLocFromIndex(start + match[0].length),
                },
                messageId: 'history',
                data: { what, token: match[0] },
              })
            }
          }
        }
      },
    }
  },
}

export default { rules: { 'no-history': rule } }
