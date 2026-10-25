/**
 * **A link dropped on a dropzone.** A dragged tab, bookmark or link carries
 * `text/uri-list` and no files; this one predicate turns that drop into a
 * clip, so the Files tab and a space's Sources cannot disagree.
 * - RFC 2483: lines, `#` lines are comments, the first other line is the URL
 *   (Firefox sends the URL and then its title).
 * - **One link, not N.** Several links are added deliberately in the dialog.
 */

/** The first URL a `text/uri-list` payload names, or null. */
export function firstUri(payload: string): string | null {
  for (const line of payload.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    return trimmed
  }
  return null
}

/**
 * What this drop is: a link to clip, or nothing this helper has an opinion
 * about. **Files win** — a drop carrying both is a file drop, because the
 * bytes are the thing the reader dragged and a browser adds the uri-list
 * itself when the file came from a page.
 *
 * Must be called synchronously inside the `drop` handler: `getData` answers
 * the empty string once the event has been dispatched, so reading it after
 * an `await` silently loses the URL.
 */
export function droppedUrl(dataTransfer: DataTransfer): string | null {
  if (dataTransfer.files.length > 0) return null
  if (!dataTransfer.types.includes('text/uri-list')) return null
  return firstUri(dataTransfer.getData('text/uri-list'))
}
