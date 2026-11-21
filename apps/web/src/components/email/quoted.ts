/**
 * A message body without its quoted history and footers: the earlier
 * message a reply quotes (`On … wrote:`, `-----Original Message-----`, a
 * Gmail or Outlook quote block, `>` lines) and a calendar invitation's
 * boilerplate. A message card prints the rest and folds this to a chip.
 * A forwarded message is the content, not history, and is never folded.
 */

/** A line that starts what folds, through the end of the body. */
const FOLD_FROM: ReadonlyArray<RegExp> = [
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^On\b.*\bwrote:\s*$/,
  /^>/,
  /^Invitation from Google Calendar\b/i,
  /^You are receiving this (courtesy )?email\b/i,
]

/** A two-line `On … ,\n… wrote:` header, as Gmail wraps a long one. */
const WRAPPED_WROTE = /^On\b/

/** A plain-text body split where its history starts; `quoted` null when nothing folds. */
export function splitQuotedText(text: string): {
  main: string
  quoted: string | null
} {
  const lines = text.split('\n')
  const at = lines.findIndex(
    (line, i) =>
      FOLD_FROM.some((re) => re.test(line.trim())) ||
      (WRAPPED_WROTE.test(line.trim()) &&
        /\bwrote:\s*$/.test(lines.at(i + 1)?.trim() ?? '')),
  )
  // A body that is nothing but history keeps it: there would be nothing left.
  const main = at <= 0 ? '' : lines.slice(0, at).join('\n').trimEnd()
  if (at <= 0 || main.trim() === '') return { main: text, quoted: null }
  return { main, quoted: lines.slice(at).join('\n') }
}

/** The quote blocks mail clients mark, outermost first. */
const QUOTE_BLOCKS = [
  'div.gmail_quote',
  'blockquote[type="cite"]',
  '#divRplyFwdMsg',
  '#appendonsend',
  '.yahoo_quoted',
  'div[id^="mail-editor-reference-message"]',
].join(', ')

const FORWARDED = /^-+\s*Forwarded message\s*-+/i

/** The text markers inside HTML that start what folds. */
const HTML_FOLD_TEXT: ReadonlyArray<RegExp> = [
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^Invitation from Google Calendar\b/i,
  /^You are receiving this (courtesy )?email\b/i,
]

/** Removes `from` and everything after it in document order. */
function cutFrom(from: Element, body: HTMLElement) {
  let node: Element | null = from
  while (node !== null && node !== body) {
    while (node.nextSibling !== null) node.nextSibling.remove()
    const parent: HTMLElement | null = node.parentElement
    if (node === from) node.remove()
    node = parent
  }
}

/**
 * The sanitized document with its history cut, or null when nothing folds
 * (or there is no parser, as on the server). The cut copy keeps the head,
 * so its CSP and styles hold.
 */
export function trimQuotedHtml(srcdoc: string): string | null {
  if (typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(srcdoc, 'text/html')
  const body = doc.body
  const before = body.textContent.trim()
  const block = [...body.querySelectorAll(QUOTE_BLOCKS)].find(
    (el) => !FORWARDED.test(el.textContent.trim()),
  )
  const marker = [...body.querySelectorAll('*')].find(
    (el) =>
      el.children.length === 0 &&
      HTML_FOLD_TEXT.some((re) => re.test(el.textContent.trim())),
  )
  const first =
    block !== undefined && marker !== undefined
      ? block.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING
        ? block
        : marker
      : (block ?? marker)
  if (first === undefined) return null
  cutFrom(first, body)
  const after = body.textContent.trim()
  if (after === '' || after === before) return null
  return `<!doctype html>${doc.documentElement.outerHTML}`
}
