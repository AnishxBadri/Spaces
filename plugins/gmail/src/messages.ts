import { z } from 'zod'

/**
 * Gmail's resources, read, and the batch request written and parsed. Pure:
 * no port, no clock — the job decides what to fetch and where to send it.
 */

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'
export const GMAIL_BATCH = 'https://gmail.googleapis.com/batch/gmail/v1'

/** Gets per batch: Gmail allows 100 and throttles above 50. */
export const BATCH_SIZE = 50

/** Ids per `messages.list` or `history.list` page. */
export const PAGE_SIZE = 500

export const messageRef = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
})

export const messagesPage = z.object({
  messages: z.array(messageRef).default([]),
  nextPageToken: z.string().min(1).optional(),
})

export const historyPage = z.object({
  history: z
    .array(
      z.object({
        id: z.string().min(1),
        messagesAdded: z
          .array(
            z.object({
              message: messageRef.extend({
                labelIds: z.array(z.string()).default([]),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  nextPageToken: z.string().min(1).optional(),
  historyId: z.string().min(1),
})

export const profile = z.object({ historyId: z.string().min(1) })

/** `messages.get?format=raw`: the bytes and what the mailbox knows of them. */
export const rawMessage = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  internalDate: z.string().regex(/^\d+$/),
  raw: z.string().min(1),
  snippet: z.string().optional(),
})

export type RawMessage = z.output<typeof rawMessage>

export const labelsList = z.object({
  labels: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
})

/**
 * The names a person knows labels by. The category tabs are named as Gmail
 * shows them, so an exclude list says `Promotions`, not an id.
 */
const SYSTEM_NAMES: { readonly [id: string]: string } = {
  INBOX: 'Inbox',
  SENT: 'Sent',
  DRAFT: 'Drafts',
  SPAM: 'Spam',
  TRASH: 'Trash',
  IMPORTANT: 'Important',
  STARRED: 'Starred',
  UNREAD: 'Unread',
  CHAT: 'Chat',
  CATEGORY_PERSONAL: 'Primary',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
}

const ENTITIES: { readonly [name: string]: string } = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * Gmail's `snippet` as plain text: it arrives HTML-escaped (`&#39;`,
 * `&amp;`). Undefined when nothing is left, so the claim carries no field.
 */
export const snippetText = (
  snippet: string | undefined,
): string | undefined => {
  const text = (snippet ?? '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&([a-z]+);/gi, (whole, name: string) =>
      Object.hasOwn(ENTITIES, name.toLowerCase())
        ? ENTITIES[name.toLowerCase()]
        : whole,
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)
  return text === '' ? undefined : text
}

/** Label ids → names: the system ones by `SYSTEM_NAMES`, a user label by `labels.list`. */
export const labelNames = (
  ids: ReadonlyArray<string>,
  userLabels: ReadonlyMap<string, string>,
): Array<string> =>
  ids.map((id) =>
    Object.hasOwn(SYSTEM_NAMES, id)
      ? SYSTEM_NAMES[id]
      : (userLabels.get(id) ?? id),
  )

/** A label id that only `labels.list` can name. */
export const isUserLabel = (id: string): boolean =>
  !Object.hasOwn(SYSTEM_NAMES, id)

export const url = (
  path: string,
  query: { readonly [name: string]: string | undefined } = {},
): string => {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query))
    if (value !== undefined) search.set(name, value)
  const tail = search.toString()
  return `${GMAIL_API}${path}${tail === '' ? '' : `?${tail}`}`
}

export const BOUNDARY = 'spaces_gmail_batch'

/** One batch request body: a raw `messages.get` per id, in order. */
export const batchBody = (ids: ReadonlyArray<string>): string =>
  [
    ...ids.flatMap((id, i) => [
      `--${BOUNDARY}`,
      'Content-Type: application/http',
      `Content-ID: <item-${i}>`,
      '',
      `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=raw`,
      '',
    ]),
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n')

/** One answer inside a batch: its HTTP status and body, by request index. */
export type BatchPart = {
  readonly index: number
  readonly status: number
  readonly body: string
}

/**
 * A batch response → its parts. Null when the response is not a readable
 * multipart; a part whose status line or index cannot be read is left out,
 * and the job treats a missing answer as a failed one.
 */
export const parseBatch = (
  contentType: string,
  body: string,
): Array<BatchPart> | null => {
  const boundary = /boundary="?([^";\s]+)"?/i.exec(contentType)?.[1]
  if (boundary === undefined) return null
  const parts: Array<BatchPart> = []
  for (const chunk of body.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith('--')) break
    const index = /content-id:\s*<?response-item-(\d+)>?/i.exec(chunk)?.[1]
    const status = /HTTP\/\d(?:\.\d)? (\d{3})/.exec(chunk)
    if (index === undefined || status === null) continue
    const afterStatus = chunk.slice(status.index)
    const blank = /\r?\n\r?\n/.exec(afterStatus)
    parts.push({
      index: Number(index),
      status: Number(status[1]),
      body:
        blank === null
          ? ''
          : afterStatus.slice(blank.index + blank[0].length).trim(),
    })
  }
  return parts
}
