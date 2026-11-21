/**
 * The raw MIME as an email keeps it: every header, the text and HTML parts,
 * the inline images the HTML shows, and every other part's headers with its
 * body dropped. An attachment is a document of its own (or stays in the
 * mailbox), so its bytes are never stored a second time inside the email.
 * - Pure, and byte-exact for what it keeps: the message is read as latin1,
 *   which maps every byte to one code unit and back.
 * - A part with no parseable structure is kept as it came; a malformed
 *   multipart is left whole rather than guessed at.
 */

const HEADER_END = /\r?\n\r?\n/

type Entity = {
  head: string
  /** The blank line between the headers and the body, as sent. */
  gap: string
  body: string
  headers: ReadonlyMap<string, string>
}

function entityOf(raw: string): Entity | null {
  const end = HEADER_END.exec(raw)
  if (end === null) return null
  const head = raw.slice(0, end.index)
  const headers = new Map<string, string>()
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim())
  }
  return {
    head,
    gap: end[0],
    body: raw.slice(end.index + end[0].length),
    headers,
  }
}

const mediaType = (value: string | undefined): string =>
  (value ?? 'text/plain').split(';')[0].trim().toLowerCase()

function boundaryOf(contentType: string | undefined): string | null {
  const m = /boundary\s*=\s*("[^"]+"|[^\s;]+)/i.exec(contentType ?? '')
  return m === null ? null : m[1].replace(/^"|"$/g, '')
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a leaf part is the message itself: its text, or an image the HTML shows. */
function keeps(entity: Entity, cids: ReadonlySet<string>): boolean {
  const cid = entity.headers
    .get('content-id')
    ?.replace(/^\s*<|>\s*$/g, '')
    .trim()
    .toLowerCase()
  if (cid !== undefined && cid !== '' && cids.has(cid)) return true
  const type = mediaType(entity.headers.get('content-type'))
  if (type !== 'text/plain' && type !== 'text/html') return false
  const disposition = entity.headers.get('content-disposition') ?? ''
  const named = /(^|;)\s*(file)?name\*?\s*=/i
  return (
    !/^\s*attachment/i.test(disposition) &&
    !named.test(disposition) &&
    !named.test(entity.headers.get('content-type') ?? '')
  )
}

function stripEntity(raw: string, cids: ReadonlySet<string>): string {
  const entity = entityOf(raw)
  if (entity === null) return raw
  const contentType = entity.headers.get('content-type')
  if (!mediaType(contentType).startsWith('multipart/'))
    return keeps(entity, cids) ? raw : `${entity.head}${entity.gap}`

  const boundary = boundaryOf(contentType)
  if (boundary === null) return raw
  // A delimiter line owns the line break before it (RFC 2046 §5.1.1).
  const delimiter = new RegExp(
    `(^|\\r?\\n)--${escape(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`,
    'g',
  )
  const body = entity.body
  const matches = [...body.matchAll(delimiter)]
  if (matches.length === 0) return raw
  let out = body.slice(0, matches[0].index)
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    out += m[0]
    const from = m.index + m[0].length
    if (m[2] === '--') {
      // The closing delimiter: the epilogue follows as sent.
      out += body.slice(from)
      break
    }
    const to = i + 1 < matches.length ? matches[i + 1].index : body.length
    const part = body.slice(from, to)
    const lead = /^\r?\n/.exec(part)?.[0] ?? ''
    out += lead + stripEntity(part.slice(lead.length), cids)
  }
  return `${entity.head}${entity.gap}${out}`
}

/**
 * The message with each attachment part's body dropped. `inlineCids` are the
 * Content-IDs the HTML body references (`referencedCids`), lowercased: those
 * parts render inside the mail and stay.
 */
export function stripAttachmentBodies(
  mime: Buffer,
  inlineCids: ReadonlySet<string>,
): Buffer {
  return Buffer.from(stripEntity(mime.toString('latin1'), inlineCids), 'latin1')
}
