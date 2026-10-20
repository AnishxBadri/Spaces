/**
 * The message Send writes: RFC 5322 headers over a MIME body. Pure — no
 * port, no clock; the job hands in the date and the bytes.
 * - The body is the draft's text twice: `text/plain` as written and
 *   `text/html` rendered from its markdown, as `multipart/alternative`.
 * - With files it is `multipart/mixed`: the alternative first, then each
 *   attachment once, base64.
 * - Every part is base64 and every non-ASCII header an RFC 2047 word, so
 *   the whole message is ASCII and goes over the wire as text.
 */

export type Mailbox = { readonly email: string; readonly name?: string }

export type OutgoingAttachment = {
  readonly filename: string
  readonly mime: string
  readonly bytes: Uint8Array
}

export type OutgoingMessage = {
  /** Without angle brackets. */
  readonly messageId: string
  readonly date: Date
  readonly from: Mailbox
  readonly to: ReadonlyArray<Mailbox>
  readonly cc: ReadonlyArray<Mailbox>
  readonly bcc: ReadonlyArray<Mailbox>
  readonly subject: string
  /** The draft's body, markdown. */
  readonly bodyMd: string
  /** The parent's Message-ID, without brackets; null for a new email. */
  readonly inReplyTo: string | null
  /** The thread's chain, oldest first, without brackets. */
  readonly references: ReadonlyArray<string>
  readonly attachments: ReadonlyArray<OutgoingAttachment>
}

const CRLF = '\r\n'

const ASCII = /^[\x20-\x7e]*$/

const base64OfBytes = (bytes: Uint8Array): string => {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

const utf8 = (text: string) => new TextEncoder().encode(text)

/** Bytes as base64 wrapped at 76 columns, as MIME writes a part. */
const base64Lines = (bytes: Uint8Array): string =>
  (base64OfBytes(bytes).match(/.{1,76}/g) ?? []).join(CRLF)

/** A header value as written when it is ASCII, else one RFC 2047 word. */
export const encodeWord = (text: string): string =>
  ASCII.test(text) ? text : `=?UTF-8?B?${base64OfBytes(utf8(text))}?=`

const quoted = (name: string) =>
  `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

/** `"Dana Moreau" <dana@flent.example>`, or the bare address. */
export const formatMailbox = (m: Mailbox): string => {
  const name = m.name?.trim() ?? ''
  if (name === '') return m.email
  return `${ASCII.test(name) ? quoted(name) : encodeWord(name)} <${m.email}>`
}

/** A filename parameter: quoted when ASCII, RFC 2231 otherwise. */
const filenameParam = (key: 'name' | 'filename', filename: string): string =>
  ASCII.test(filename)
    ? `${key}=${quoted(filename)}`
    : `${key}*=UTF-8''${encodeURIComponent(filename)}`

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/** Bold, italics and http(s) links inside one escaped line. */
const inline = (text: string): string =>
  escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label: string, href: string) => `<a href="${href}">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')

/**
 * The draft's markdown as HTML: paragraphs, line breaks, `>` quotes, `-`
 * lists, `#` headings, bold, italics and links. Anything else is text.
 */
export const markdownToHtml = (markdown: string): string =>
  `<!doctype html><html><body>${blocksOf(markdown)}</body></html>`

const blocksOf = (markdown: string): string => {
  const blocks = markdown.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const out: Array<string> = []
  for (const block of blocks) {
    const lines = block.split('\n')
    if (block.trim() === '') continue
    if (lines.every((l) => /^>\s?/.test(l))) {
      const inner = lines.map((l) => l.replace(/^>\s?/, '')).join('\n')
      out.push(`<blockquote>${blocksOf(inner)}</blockquote>`)
      continue
    }
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      out.push(
        `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`,
      )
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(block)
    if (heading !== null && lines.length === 1) {
      const level = String(heading[1].length)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    out.push(`<p>${lines.map(inline).join('<br>')}</p>`)
  }
  return out.join('')
}

/** A boundary no base64 line can begin with, unique to this message. */
const boundaryOf = (messageId: string, kind: string): string =>
  `=_spaces_${kind}_${messageId.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`

const textPart = (mime: string, text: string): Array<string> => [
  `Content-Type: ${mime}; charset=UTF-8`,
  'Content-Transfer-Encoding: base64',
  '',
  base64Lines(utf8(text)),
]

/** The message's RFC 5322 text. */
export const buildMime = (message: OutgoingMessage): string => {
  const list = (ms: ReadonlyArray<Mailbox>) => ms.map(formatMailbox).join(', ')
  const head = [
    `Message-ID: <${message.messageId}>`,
    `Date: ${message.date.toUTCString()}`,
    `From: ${formatMailbox(message.from)}`,
    ...(message.to.length === 0 ? [] : [`To: ${list(message.to)}`]),
    ...(message.cc.length === 0 ? [] : [`Cc: ${list(message.cc)}`]),
    ...(message.bcc.length === 0 ? [] : [`Bcc: ${list(message.bcc)}`]),
    `Subject: ${encodeWord(message.subject)}`,
    ...(message.inReplyTo === null
      ? []
      : [`In-Reply-To: <${message.inReplyTo}>`]),
    ...(message.references.length === 0
      ? []
      : [`References: ${message.references.map((r) => `<${r}>`).join(' ')}`]),
    'MIME-Version: 1.0',
  ]
  const alt = boundaryOf(message.messageId, 'alt')
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    ...textPart('text/plain', message.bodyMd),
    `--${alt}`,
    ...textPart('text/html', markdownToHtml(message.bodyMd)),
    `--${alt}--`,
  ]
  if (message.attachments.length === 0)
    return [...head, ...alternative, ''].join(CRLF)
  const mixed = boundaryOf(message.messageId, 'mixed')
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    ...alternative,
    ...message.attachments.flatMap((a) => [
      `--${mixed}`,
      `Content-Type: ${a.mime}; ${filenameParam('name', a.filename)}`,
      `Content-Disposition: attachment; ${filenameParam('filename', a.filename)}`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(a.bytes),
    ]),
    `--${mixed}--`,
    '',
  ].join(CRLF)
}

/** The boundary of the upload body `messages.send` takes. */
export const UPLOAD_BOUNDARY = 'spaces_gmail_send'

/** `messages.send`'s multipart upload: the metadata, then the message. */
export const uploadBody = (raw: string, threadId: string | null): string =>
  [
    `--${UPLOAD_BOUNDARY}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(threadId === null ? {} : { threadId }),
    `--${UPLOAD_BOUNDARY}`,
    'Content-Type: message/rfc822',
    '',
    raw,
    `--${UPLOAD_BOUNDARY}--`,
    '',
  ].join(CRLF)
