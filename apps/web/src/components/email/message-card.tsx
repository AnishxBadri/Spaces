import { Attachment, icon } from '#/components/icons'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { formatBytes } from '@spaces/core/documents'
import { dayKey, formatDay, formatTime } from '@spaces/core/format'
import { FileGlyph } from '#/components/files/file-glyph'
import { downloadDocument } from '#/components/files/file-row'
import { keepCopyItems } from '#/components/files/keep-copy'
import type { KeepCopy } from '#/components/files/keep-copy'
import { MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { fileType } from '#/lib/documents/files-tab'
import type {
  EmailAttachment,
  EmailBody,
  EmailDetail,
  EmailParticipant,
  EmailThreadLine,
} from '#/lib/server-fns'
import { splitQuotedText, trimQuotedHtml } from './quoted'

/**
 * One message of a thread as a card on the bone ground: folded to a 40px
 * line (sender → recipients in a 180px lane, the preview, the clip, the
 * stamp), or open (a 44px header over a rule, the body with its history
 * folded to a chip, then its files as cards under a rule). Every header
 * reads sender → recipients one way: `Dev Shah → you, cc Priya Raman`.
 */

/** What a folded card prints: an earlier message's line, or an open message folded. */
type CardHead = {
  id: string
  from: EmailParticipant | null
  to: ReadonlyArray<EmailParticipant>
  cc: ReadonlyArray<EmailParticipant>
  preview: string | null
  attachments: number
  /** ISO instant. */
  occurredAt: string
}

/** The folded line of a message already read in full. */
function headOf(email: EmailDetail): CardHead {
  return {
    id: email.id,
    from: email.from,
    to: email.to,
    cc: email.cc,
    preview: email.preview,
    attachments: email.attachments.length,
    occurredAt: email.occurredAt,
  }
}

/** The thread's cards in order: the earlier messages, then the newest. */
export function threadCards(
  earlier: ReadonlyArray<EmailThreadLine>,
  newest: EmailDetail,
): Array<CardHead> {
  return [...earlier, headOf(newest)]
}

/** `10:42` on the reader's day, else `13 Oct, 18:40`. */
function messageStamp(iso: string, today: string): string {
  return dayKey(iso) === today
    ? formatTime(iso)
    : `${formatDay(iso, today)}, ${formatTime(iso)}`
}

/** A piece of a header line: a name with its address, or the words between. */
type LinePart = { text: string; email: string | null }

/** How many recipients a header names before it counts the rest. */
const NAMED = 3

const nameOf = (p: EmailParticipant) => (p.you ? 'you' : (p.name ?? p.email))

const part = (p: EmailParticipant): LinePart => ({
  text: nameOf(p),
  email: p.email,
})

const words = (text: string): LinePart => ({ text, email: null })

/** `you` first among a list's names, the rest as they came. */
const youFirst = (ps: ReadonlyArray<EmailParticipant>) => [
  ...ps.filter((p) => p.you),
  ...ps.filter((p) => !p.you),
]

/** Names with `, ` between them. */
function listed(ps: ReadonlyArray<EmailParticipant>): Array<LinePart> {
  return ps.flatMap((p, i) => (i === 0 ? [part(p)] : [words(', '), part(p)]))
}

/** The sender as a header prints it: `You`, a name, or the bare address. */
function senderPart(from: EmailParticipant | null): LinePart {
  if (from === null) return words('Unknown sender')
  return {
    text: from.you ? 'You' : (from.name ?? from.email),
    email: from.email,
  }
}

/**
 * Who a message went to, after the arrow. Up to three names in full
 * (`you, cc Priya Raman`); past three, three To names, `+n` for the rest of
 * To and `· cc n`, and a folded card just its first name and `+n`.
 */
function recipientParts(
  head: Pick<CardHead, 'to' | 'cc'>,
  folded: boolean,
): Array<LinePart> {
  const to = youFirst(head.to)
  const cc = youFirst(head.cc)
  const total = to.length + cc.length
  if (total === 0) return []
  if (total <= NAMED)
    return [
      ...listed(to),
      ...(cc.length === 0
        ? []
        : [words(to.length === 0 ? 'cc ' : ', cc '), ...listed(cc)]),
    ]
  if (folded) {
    const first = to.at(0) ?? cc.at(0)
    return first === undefined
      ? []
      : [part(first), words(` +${String(total - 1)}`)]
  }
  return [
    ...listed(to.slice(0, NAMED)),
    ...(to.length > NAMED ? [words(` +${String(to.length - NAMED)}`)] : []),
    ...(cc.length === 0
      ? []
      : [words(`${to.length === 0 ? '' : ' · '}cc ${String(cc.length)}`)]),
  ]
}

/** The whole header line as text: `Dev Shah → you, cc Priya Raman`. */
export function senderLine(
  head: Pick<CardHead, 'from' | 'to' | 'cc'>,
  folded = false,
): string {
  const to = recipientParts(head, folded)
  const sender = senderPart(head.from).text
  return to.length === 0
    ? sender
    : `${sender} → ${to.map((p) => p.text).join('')}`
}

/** A name whose address is its tooltip; words print as they are. */
function Named({ part: p }: { part: LinePart }) {
  if (p.email === null || p.email === p.text) return <>{p.text}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-address={p.email}>{p.text}</span>
      </TooltipTrigger>
      <TooltipContent>{p.email}</TooltipContent>
    </Tooltip>
  )
}

/** Sender in ink, the arrow and the recipients in graphite. */
function HeaderLine({
  head,
  folded,
  tips,
}: {
  head: Pick<CardHead, 'from' | 'to' | 'cc'>
  folded: boolean
  tips: boolean
}) {
  const sender = senderPart(head.from)
  const to = recipientParts(head, folded)
  const show = (p: LinePart, i: number) =>
    tips ? <Named key={i} part={p} /> : <span key={i}>{p.text}</span>
  return (
    <>
      <span className="text-foreground">{show(sender, -1)}</span>
      {to.length === 0 ? null : (
        <span className="text-graphite">
          {' → '}
          {to.map(show)}
        </span>
      )}
    </>
  )
}

/** The clip and its count, at a folded card's end. */
function Clip({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span
      data-clip
      className="flex shrink-0 items-center gap-1 mono text-micro text-graphite"
    >
      <Attachment aria-label="Attachments" className="size-4" />
      {count}
    </span>
  )
}

const STAMP = 'w-22 shrink-0 text-right mono text-micro text-graphite'

/** A folded message: one 40px line that unfolds it in place. */
export function FoldedCard({
  head,
  today,
  onOpen,
}: {
  head: CardHead
  today: string
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      data-card={head.id}
      data-folded=""
      aria-expanded={false}
      onClick={onOpen}
      className="focus-ring flex h-10 w-full shrink-0 items-center gap-3 border border-rule bg-paper px-4 text-left hover:bg-bone"
    >
      <span
        data-sender-line
        className="w-45 shrink-0 truncate text-ui"
        title={senderLine(head, true)}
      >
        <HeaderLine head={head} folded tips={false} />
      </span>
      <span className="min-w-0 flex-1 truncate text-ui text-graphite">
        {head.preview ?? ''}
      </span>
      <Clip count={head.attachments} />
      <span className={STAMP}>{messageStamp(head.occurredAt, today)}</span>
    </button>
  )
}

/** The sandboxed body, sized to what it holds. */
function EmailFrame({ srcdoc }: { srcdoc: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(240)
  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (doc) setHeight(doc.documentElement.scrollHeight)
  }, [])
  return (
    <iframe
      ref={frame}
      title="Email body"
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcdoc}
      onLoad={measure}
      style={{ height }}
      className="block w-full border-0 bg-paper"
    />
  )
}

/** The bone `···` chip that unfolds a body's quoted history and footers. */
function QuotedChip({
  open,
  onToggle,
}: {
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      data-quoted-chip
      aria-expanded={open}
      aria-label={open ? 'Hide quoted text' : 'Show quoted text'}
      onClick={onToggle}
      className="focus-ring flex h-5 w-fit items-center border border-rule bg-bone px-1 text-graphite hover:text-foreground"
    >
      <icon.more aria-hidden className="size-4" />
    </button>
  )
}

function remoteLine(body: EmailBody): string | null {
  if (body.kind !== 'html' || body.remoteImages === 0) return null
  const n = body.remoteImages
  return `${String(n)} remote image${n === 1 ? '' : 's'} not loaded`
}

/** The body as a card prints it, its history behind the chip. */
function MessageBody({ email }: { email: EmailDetail }) {
  const [quoted, setQuoted] = useState(false)
  const body = email.body
  const trimmed = useMemo(
    () => (body.kind === 'html' ? trimQuotedHtml(body.srcdoc) : null),
    [body],
  )
  const split = useMemo(
    () => (body.kind === 'text' ? splitQuotedText(body.text) : null),
    [body],
  )
  if (body.kind === 'none') return null
  const remote = remoteLine(body)
  const owner = email.privacy?.owner.name ?? email.via ?? 'its owner'
  const folds =
    (body.kind === 'html' && trimmed !== null) ||
    (split !== null && split.quoted !== null)
  const content: ReactNode =
    body.kind === 'html' ? (
      <EmailFrame
        key={quoted ? 'whole' : 'trimmed'}
        srcdoc={quoted ? body.srcdoc : (trimmed ?? body.srcdoc)}
      />
    ) : body.kind === 'text' ? (
      <div className="text-body break-words whitespace-pre-wrap">
        {quoted || split === null ? body.text : split.main}
      </div>
    ) : (
      <p
        data-body-private
        className="border border-rule bg-bone px-4 py-6 text-center text-ui text-graphite"
      >
        Private to {owner}&rsquo;s mailbox
      </p>
    )
  return (
    <div className="flex flex-col gap-3 p-4">
      {content}
      {folds ? (
        <QuotedChip open={quoted} onToggle={() => setQuoted((q) => !q)} />
      ) : null}
      {remote === null ? null : (
        <span data-remote-images className="mono text-micro text-graphite">
          {remote}
        </span>
      )}
    </div>
  )
}

/** One lane of the address block: `From`, `To`, `Cc`, `Bcc`. */
function AddressLane({
  label,
  people,
}: {
  label: string
  people: ReadonlyArray<EmailParticipant>
}) {
  if (people.length === 0) return null
  return (
    <div data-address-lane={label} className="flex items-baseline gap-3">
      <dt className="w-10 shrink-0 text-label text-graphite">{label}</dt>
      <dd className="min-w-0 flex-1 text-label break-words text-foreground">
        {listed(youFirst(people)).map((p, i) => (
          <Named key={i} part={p} />
        ))}
      </dd>
    </div>
  )
}

/** From, To, Cc and — on mail from the reader's own mailbox — Bcc, on bone. */
function AddressBlock({ email }: { email: EmailDetail }) {
  return (
    <dl
      data-address-block
      className="flex flex-col gap-1 border-b border-rule bg-bone px-4 py-2.5"
    >
      <AddressLane
        label="From"
        people={email.from === null ? [] : [email.from]}
      />
      <AddressLane label="To" people={email.to} />
      <AddressLane label="Cc" people={email.cc} />
      <AddressLane label="Bcc" people={email.bcc} />
    </dl>
  )
}

/** What a message's files do: open the viewer, file it, mark it a newer version. */
export type FileActions = {
  recordId: string | null
  /** Opens the viewer on `a`, stepping through the files of its message. */
  onOpen: (a: EmailAttachment, of: ReadonlyArray<EmailAttachment>) => void
  onFileOn: (a: EmailAttachment) => void
  onNewer: (a: EmailAttachment) => void
  /** Keeps a copy of a file that stays in the mailbox; the thread re-reads after. */
  keeper: KeepCopy
}

/**
 * A file card's `···`: Open, Download, Keep a copy, File on… and — opened
 * from a record — Newer version of…. A file still in the mailbox downloads
 * through it; one whose mailbox is gone has no file to download or keep.
 */
function fileMenu(
  a: EmailAttachment,
  open: () => void,
  actions: FileActions,
): Array<MoreMenuEntry> {
  return [
    { label: 'Open', icon: <icon.open />, opens: true, onSelect: open },
    ...(a.remoteBytes === 'gone'
      ? []
      : [
          {
            label: 'Download',
            icon: <icon.download />,
            onSelect: () =>
              void downloadDocument(a.documentId, a.remoteBytes === 'linked'),
          },
        ]),
    ...keepCopyItems(
      { id: a.documentId, remoteBytes: a.remoteBytes },
      actions.keeper,
    ),
    {
      label: 'File on…',
      icon: <icon.fileOn />,
      opens: true,
      onSelect: () => actions.onFileOn(a),
    },
    ...(actions.recordId === null
      ? []
      : [
          {
            label: 'Newer version of…',
            icon: <icon.version />,
            opens: true,
            onSelect: () => actions.onNewer(a),
          },
        ]),
  ]
}

/** A file as a 228px card: its page glyph, the full name, the size, a `···`. */
function FileCard({
  a,
  files,
  actions,
}: {
  a: EmailAttachment
  files: ReadonlyArray<EmailAttachment>
  actions: FileActions
}) {
  const open = () => actions.onOpen(a, files)
  const size = formatBytes(a.sizeBytes)
  return (
    <li data-file-card={a.documentId} className="relative flex w-57 shrink-0">
      <button
        type="button"
        onClick={open}
        className="focus-ring flex min-w-0 flex-1 gap-2.5 border border-rule bg-paper py-2.5 pr-2.5 pl-3 text-left hover:bg-bone"
      >
        <FileGlyph
          type={fileType({
            filename: a.filename,
            mime: a.mime,
            externalUrl: null,
          })}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-ui break-words">{a.name}</span>
          <span data-file-size className="h-6 mono text-micro text-graphite">
            {size}
          </span>
        </span>
      </button>
      <MoreMenu
        variant="row"
        label={a.name}
        items={fileMenu(a, open, actions)}
        className="absolute right-2 bottom-2"
      />
    </li>
  )
}

/** Reply, Reply all and Forward, from one message. */
export type ReplyMode = 'reply' | 'reply_all' | 'forward'

/**
 * An open message: its header (the line opens the address block, then the
 * stamp and the message's own `···`), its body, and its files under a rule.
 */
export function OpenCard({
  email,
  today,
  actions,
  onDraft,
}: {
  email: EmailDetail
  today: string
  actions: FileActions
  onDraft: (messageId: string, mode: ReplyMode) => void
}) {
  const [addresses, setAddresses] = useState(false)
  return (
    <article
      data-card={email.id}
      data-message={email.id}
      aria-label={senderLine(email)}
      className="flex shrink-0 flex-col border border-rule bg-paper"
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-rule px-4">
        <button
          type="button"
          data-sender-line
          aria-expanded={addresses}
          onClick={() => setAddresses((v) => !v)}
          className="focus-ring min-w-0 flex-1 truncate text-left text-ui"
        >
          <HeaderLine head={email} folded={false} tips />
        </button>
        <span className={STAMP}>{messageStamp(email.occurredAt, today)}</span>
        <MoreMenu
          variant="row"
          label={`message from ${senderPart(email.from).text}`}
          forceMenu
          items={[
            {
              label: 'Reply',
              icon: <icon.reply />,
              opens: true,
              onSelect: () => onDraft(email.id, 'reply'),
            },
            {
              label: 'Reply all',
              icon: <icon.replyAll />,
              opens: true,
              onSelect: () => onDraft(email.id, 'reply_all'),
            },
            {
              label: 'Forward',
              icon: <icon.forward />,
              opens: true,
              onSelect: () => onDraft(email.id, 'forward'),
            },
          ]}
        />
      </header>
      {addresses ? <AddressBlock email={email} /> : null}
      <MessageBody email={email} />
      {email.attachments.length === 0 ? null : (
        <ul
          aria-label="Files"
          data-files-of={email.id}
          className="flex flex-wrap gap-2 border-t border-rule px-4 pt-3 pb-4"
        >
          {email.attachments.map((a) => (
            <FileCard
              key={a.documentId}
              a={a}
              files={email.attachments}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </article>
  )
}
