/**
 * **A link dropped on a dropzone** (SPA-117, §3.1 entry point 5's second
 * half).
 *
 * Dragging a tab, a bookmark or a link out of any browser puts
 * `text/uri-list` on the `DataTransfer` and no files. The Files tab and a
 * space's Sources already accept a file drop; this is the one predicate that
 * turns the same gesture on a *link* into a clip instead of a no-op, and it
 * lives here rather than twice in tsx so the two surfaces cannot disagree
 * about what counts as a link.
 *
 * RFC 2483's format is lines, where a line beginning `#` is a comment — the
 * first non-comment line is the URL. Chrome and Safari send exactly one line;
 * Firefox sends the URL and then its title, so taking the first line rather
 * than the whole payload is not pedantry.
 *
 * **One link, not N.** A multi-select drag would give several, and filing
 * them would mean N server calls, N rows and N toasts from one gesture whose
 * feedback is a single line. The dialog's field is where a person adds
 * several deliberately.
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
