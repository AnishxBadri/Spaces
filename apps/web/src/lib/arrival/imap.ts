import { Effect, Schema } from 'effect'
import { ImapFlow } from 'imapflow'

/**
 * The IMAP half of the forwarding mailbox (SPA-56, D31): log in with the app
 * password, open the folder read-only, and hand back the raw RFC 822 bytes
 * of every message above the cursor. Nothing here parses mail or touches the
 * database — `poll.ts` does both — so the one thing this module owns is the
 * protocol, and the one trap in it: **UIDVALIDITY**.
 *
 * A UID only names a message under the UIDVALIDITY it was read with. When the
 * server changes it (a folder deleted and recreated, a provider migrating its
 * store), a cursor of "above UID 812" silently skips the whole renumbered
 * folder, or silently re-imports it if the new numbers happen to run higher.
 * So the cursor carries the validity it was taken under, and a mismatch
 * restarts from UID 0. The re-import that causes is harmless by construction:
 * `interaction_message_id_unique` is the dedupe, not this cursor.
 *
 * Opened with `EXAMINE`, never `SELECT`: a poll reads, and must not flip the
 * `\Seen` flag on mail somebody may still be reading in that mailbox.
 */

/** Where to connect; `pass` is the decrypted app password. */
export type MailboxConnection = {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  folder: string
}

/** The cursor the mailbox row carries. */
export type MailCursor = { lastUid: number; lastUidValidity: number | null }

export type FetchedMail = { uid: number; source: Buffer }

export type FetchResult = {
  uidValidity: number
  /** True when the server's UIDVALIDITY differed and the cursor restarted. */
  reset: boolean
  /** Ascending by UID, at most `limit` of them. */
  messages: Array<FetchedMail>
  /** UIDs above the cursor this poll left for the next one. */
  remaining: number
}

/** The server refused the login; `reason` is its own words. */
export class MailAuthRefused extends Schema.TaggedError<MailAuthRefused>()(
  'MailAuthRefused',
  { reason: Schema.String },
) {}

/** No session: DNS, a refused connection, TLS, a missing folder, a timeout. */
export class MailUnreachable extends Schema.TaggedError<MailUnreachable>()(
  'MailUnreachable',
  { reason: Schema.String },
) {}

export type MailFailure = MailAuthRefused | MailUnreachable

/**
 * One poll's ceiling. A first poll of a mailbox with years in it would
 * otherwise read every body into memory in one job; the cursor advances to
 * the last UID taken and the next tick carries on.
 */
export const MAX_PER_POLL = 200

const CONNECT_TIMEOUT_MS = 20_000

function client(conn: MailboxConnection): ImapFlow {
  return new ImapFlow({
    host: conn.host,
    port: conn.port,
    secure: conn.secure,
    auth: { user: conn.user, pass: conn.pass },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS * 3,
    disableAutoIdle: true,
  })
}

/**
 * imapflow's failures, sorted. A refused login carries
 * `authenticationFailed` and the server's text in `response` (LOGIN) or
 * `responseText`; everything else is a place we could not reach.
 */
function classify(err: unknown): MailFailure {
  const record: Record<string, unknown> =
    typeof err === 'object' && err !== null ? { ...err } : {}
  // `response` is the whole tagged line (`3 NO [AUTHENTICATIONFAILED] …`);
  // the tag and status are ours, the rest is the server's reason.
  const text = [record.response, record.responseText]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.replace(/^\S+\s+(?:NO|BAD)\s+/i, '').trim())
    .at(0)
  const message = err instanceof Error ? err.message : String(err)
  if (record.authenticationFailed === true)
    return new MailAuthRefused({ reason: text ?? message })
  return new MailUnreachable({ reason: text ?? message })
}

/**
 * Connect, run `body` against the open folder, and always leave: `logout()`
 * on the way out of a success, `close()` on the way out of anything else.
 */
function withFolder<TValue>(
  conn: MailboxConnection,
  body: (
    imap: ImapFlow,
    uidValidity: number,
    exists: number,
  ) => Promise<TValue>,
): Effect.Effect<TValue, MailFailure> {
  return Effect.tryPromise({
    try: async () => {
      const imap = client(conn)
      // imapflow emits `error` on socket trouble after connect; an unheard
      // `error` event is a process crash, which a worker must never be.
      imap.on('error', () => undefined)
      try {
        await imap.connect()
        const lock = await imap.getMailboxLock(conn.folder, { readOnly: true })
        try {
          const box = imap.mailbox
          if (box === false) throw new Error(`Could not open ${conn.folder}`)
          return await body(imap, Number(box.uidValidity), box.exists)
        } finally {
          lock.release()
        }
      } finally {
        if (imap.usable) await imap.logout().catch(() => imap.close())
        else imap.close()
      }
    },
    catch: classify,
  })
}

/**
 * The poll's read: every UID above the cursor (from 0 when UIDVALIDITY moved),
 * ascending, capped at `limit`, with its raw bytes.
 *
 * Two fetches rather than one. The first asks for UIDs only — cheap, and
 * what lets the cap be taken before any body is read. It is also where the
 * `n:*` quirk is dealt with: RFC 3501 makes `*` the highest UID in the folder
 * and a range unordered, so `813:*` on a folder whose last UID is 812 names
 * UID 812. The filter below is what stops that message being re-read on
 * every quiet poll forever.
 */
export function fetchSince(
  conn: MailboxConnection,
  cursor: MailCursor,
  limit: number = MAX_PER_POLL,
): Effect.Effect<FetchResult, MailFailure> {
  return withFolder(conn, async (imap, uidValidity, exists) => {
    const reset =
      cursor.lastUidValidity !== null && cursor.lastUidValidity !== uidValidity
    const after = reset ? 0 : cursor.lastUid
    if (exists === 0) return { uidValidity, reset, messages: [], remaining: 0 }

    const uids: Array<number> = []
    for await (const msg of imap.fetch(
      `${String(after + 1)}:*`,
      { uid: true },
      { uid: true },
    )) {
      if (msg.uid > after) uids.push(msg.uid)
    }
    uids.sort((a, b) => a - b)
    const take = uids.slice(0, limit)
    if (take.length === 0)
      return { uidValidity, reset, messages: [], remaining: 0 }

    const messages: Array<FetchedMail> = []
    for await (const msg of imap.fetch(
      take.join(','),
      { uid: true, source: true },
      { uid: true },
    )) {
      if (msg.source !== undefined && take.includes(msg.uid))
        messages.push({ uid: msg.uid, source: msg.source })
    }
    messages.sort((a, b) => a.uid - b.uid)
    return {
      uidValidity,
      reset,
      messages,
      remaining: uids.length - take.length,
    }
  })
}

/** Settings → Arrival's Test connection: log in, open the folder, count. */
export function probe(
  conn: MailboxConnection,
): Effect.Effect<{ uidValidity: number; exists: number }, MailFailure> {
  return withFolder(conn, (_imap, uidValidity, exists) =>
    Promise.resolve({ uidValidity, exists }),
  )
}
