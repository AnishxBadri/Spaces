import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'

/**
 * An in-repo IMAP server, just enough of RFC 3501 for imapflow to log in,
 * open a folder and `UID FETCH` it (SPA-56). imapflow ships no test
 * utilities, and the poll's two load-bearing claims — a re-poll writes
 * nothing twice, and a changed UIDVALIDITY restarts from UID 1 — are claims
 * about what a *server* says, so they want a server, on loopback, with no
 * network and no Docker.
 *
 * Plain TCP only (the mailbox row says `use_tls: false` in the tests). It
 * advertises `IMAP4rev1 NAMESPACE UIDPLUS` and nothing else, so imapflow
 * takes the plain `LOGIN` path, asks for no `ENABLE`, `ID` or `COMPRESS`,
 * and never tries STARTTLS. Commands it answers:
 *
 *   CAPABILITY · LOGIN · NAMESPACE · LIST · LSUB · SELECT · EXAMINE ·
 *   UID FETCH (UID, BODY[] / BODY.PEEK[]) · NOOP · CLOSE · UNSELECT · LOGOUT
 *
 * and anything else gets `BAD`, which shows up in `commands` for a test that
 * wants to know what was asked. A `{n}` literal is answered with a `+`
 * continuation, the way a real server does when LITERAL+ is not advertised.
 *
 * The state a test drives is plain fields: `messages` (uid + raw RFC 822
 * text), `uidValidity`, and `password`. A wrong password answers
 * `NO [AUTHENTICATIONFAILED] <authFailure>`, the shape Gmail and Fastmail
 * both use, so the poll's "server's reason" is this string.
 */

export type FakeMessage = { uid: number; raw: string }

const CAPABILITIES = 'IMAP4rev1 NAMESPACE UIDPLUS'

export class FakeImapServer {
  user: string
  password: string
  folder = 'INBOX'
  uidValidity = 1
  messages: Array<FakeMessage> = []
  authFailure = 'Invalid credentials (Failure)'
  /** Every command line received, tag stripped, in order. */
  readonly commands: Array<string> = []
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()

  constructor(opts: { user: string; password: string }) {
    this.user = opts.user
    this.password = opts.password
  }

  /** Appends a message at the next UID and returns that UID. */
  deliver(raw: string): number {
    const uid = (this.messages.at(-1)?.uid ?? 0) + 1
    this.messages.push({ uid, raw: raw.replace(/\r?\n/g, '\r\n') })
    return uid
  }

  /**
   * What a recreated folder looks like to a client: a new UIDVALIDITY and
   * the same messages renumbered from 1.
   */
  renumber(uidValidity: number): void {
    this.uidValidity = uidValidity
    this.messages = this.messages.map((m, i) => ({ uid: i + 1, raw: m.raw }))
  }

  async start(): Promise<number> {
    const server = createServer((socket) => this.session(socket))
    this.server = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('fake IMAP server has no port')
    return address.port
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    const server = this.server
    if (server === null) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.server = null
  }

  private session(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => undefined)
    const write = (s: string) => {
      if (!socket.destroyed) socket.write(s)
    }
    write(`* OK [CAPABILITY ${CAPABILITIES}] fake IMAP ready\r\n`)

    let buffer = Buffer.alloc(0)
    // A command line in progress: the text so far and, while a literal is
    // being read, how many bytes of it are still owed.
    let line = ''
    let owed = 0
    let literals: Array<string> = []

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (owed > 0) {
          if (buffer.length < owed) return
          literals.push(buffer.subarray(0, owed).toString('utf8'))
          buffer = buffer.subarray(owed)
          owed = 0
          continue
        }
        const nl = buffer.indexOf('\r\n')
        if (nl < 0) return
        line += buffer.subarray(0, nl).toString('utf8')
        buffer = buffer.subarray(nl + 2)
        const literal = /\{(\d+)\}$/.exec(line)
        if (literal) {
          owed = Number(literal[1])
          // A placeholder the tokenizer swaps for the literal's bytes.
          line = `${line.slice(0, literal.index)}\u0000${String(literals.length)}\u0000`
          write('+ go ahead\r\n')
          continue
        }
        const complete = line
        const values = literals
        line = ''
        literals = []
        this.handle(tokenize(complete, values), write, socket)
      }
    })
  }

  private handle(
    args: Array<string>,
    write: (s: string) => void,
    socket: Socket,
  ): void {
    const tag = args.shift() ?? '*'
    let command = (args.shift() ?? '').toUpperCase()
    if (command === 'UID') command = `UID ${(args.shift() ?? '').toUpperCase()}`
    this.commands.push(
      command === 'LOGIN' ? 'LOGIN' : [command, ...args].join(' '),
    )

    switch (command) {
      case 'CAPABILITY':
        write(`* CAPABILITY ${CAPABILITIES}\r\n${tag} OK CAPABILITY done\r\n`)
        return
      case 'LOGIN': {
        const [user, pass] = args
        if (user === this.user && pass === this.password) {
          write(`${tag} OK [CAPABILITY ${CAPABILITIES}] Logged in\r\n`)
        } else {
          write(`${tag} NO [AUTHENTICATIONFAILED] ${this.authFailure}\r\n`)
        }
        return
      }
      case 'NAMESPACE':
        write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE done\r\n`)
        return
      case 'LIST':
      case 'LSUB': {
        const pattern = args.at(1) ?? ''
        if (pattern === '') {
          write(`* ${command} (\\Noselect) "/" ""\r\n`)
        } else if (
          pattern === '*' ||
          pattern === '%' ||
          pattern.toUpperCase() === this.folder.toUpperCase()
        ) {
          write(`* ${command} (\\HasNoChildren) "/" "${this.folder}"\r\n`)
        }
        write(`${tag} OK ${command} done\r\n`)
        return
      }
      case 'SELECT':
      case 'EXAMINE': {
        const path = args.at(0) ?? ''
        if (path.toUpperCase() !== this.folder.toUpperCase()) {
          write(`${tag} NO [NONEXISTENT] Unknown folder\r\n`)
          return
        }
        const next = (this.messages.at(-1)?.uid ?? 0) + 1
        write(
          `* FLAGS (\\Seen \\Answered)\r\n` +
            `* ${String(this.messages.length)} EXISTS\r\n` +
            `* 0 RECENT\r\n` +
            `* OK [UIDVALIDITY ${String(this.uidValidity)}] UIDs valid\r\n` +
            `* OK [UIDNEXT ${String(next)}] Predicted next UID\r\n` +
            `${tag} OK [${command === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${command} completed\r\n`,
        )
        return
      }
      case 'UID FETCH': {
        const set = args.at(0) ?? ''
        const items = args.slice(1).join(' ').toUpperCase()
        const withBody =
          items.includes('BODY[]') || items.includes('BODY.PEEK[]')
        const max = this.messages.at(-1)?.uid ?? 0
        const wanted = uidSet(set, max)
        this.messages.forEach((m, i) => {
          if (!wanted(m.uid)) return
          const seq = String(i + 1)
          if (withBody) {
            const bytes = Buffer.byteLength(m.raw, 'utf8')
            write(
              `* ${seq} FETCH (UID ${String(m.uid)} BODY[] {${String(bytes)}}\r\n${m.raw})\r\n`,
            )
          } else {
            write(`* ${seq} FETCH (UID ${String(m.uid)})\r\n`)
          }
        })
        write(`${tag} OK UID FETCH completed\r\n`)
        return
      }
      case 'NOOP':
      case 'CHECK':
      case 'CLOSE':
      case 'UNSELECT':
        write(`${tag} OK ${command} done\r\n`)
        return
      case 'LOGOUT':
        write(`* BYE fake IMAP signing off\r\n${tag} OK LOGOUT done\r\n`)
        socket.end()
        return
      default:
        write(`${tag} BAD ${command || 'empty'} is not spoken here\r\n`)
    }
  }
}

/**
 * IMAP arguments: atoms, "quoted strings", literals (the `\u0000<n>\u0000`
 * placeholder the reader left for the n-th literal's bytes), and
 * parenthesised lists kept as one token.
 */
function tokenize(line: string, literals: Array<string>): Array<string> {
  const out: Array<string> = []
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === ' ') {
      i++
    } else if (c === '"') {
      let s = ''
      i++
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i++
        s += line[i]
        i++
      }
      i++
      out.push(s)
    } else if (c === '\u0000') {
      const end = line.indexOf('\u0000', i + 1)
      out.push(literals[Number(line.slice(i + 1, end))] ?? '')
      i = end + 1
    } else if (c === '(') {
      let depth = 0
      let s = ''
      while (i < line.length) {
        if (line[i] === '(') depth++
        if (line[i] === ')') depth--
        s += line[i]
        i++
        if (depth === 0) break
      }
      out.push(s)
    } else {
      let s = ''
      while (i < line.length && line[i] !== ' ') {
        // `BODY.PEEK[]` and friends carry brackets; keep them in the atom.
        s += line[i]
        i++
      }
      out.push(s)
    }
  }
  return out
}

/**
 * A UID set (`5`, `3:7`, `4:*`, `1,4:6`) as a predicate. `*` is the highest
 * UID in the folder, and a range is unordered — so `9:*` on a folder whose
 * last UID is 4 names UID 4, which is the RFC 3501 quirk the poll has to
 * filter out rather than re-import.
 */
function uidSet(set: string, max: number): (uid: number) => boolean {
  const parts = set.split(',').map((part) => {
    const a = part.split(':').at(0)
    const b = part.split(':').at(1)
    const lo = a === '*' ? max : Number(a)
    const hi = b === undefined ? lo : b === '*' ? max : Number(b)
    return [Math.min(lo, hi), Math.max(lo, hi)] as const
  })
  return (uid) => parts.some(([lo, hi]) => uid >= lo && uid <= hi)
}
