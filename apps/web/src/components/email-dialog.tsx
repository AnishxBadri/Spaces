import { useNavigate, useSearch } from '@tanstack/react-router'
import { Paperclip, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { formatBytes } from '@spaces/core/documents'
import { dayKey, formatDay, formatTime } from '@spaces/core/format'
import { DocumentPreview } from '#/components/document-preview'
import { DraftComposer } from '#/components/email/draft-composer'
import { FileGlyph } from '#/components/files/file-glyph'
import { downloadDocument } from '#/components/files/file-row'
import { NewerVersionDialog } from '#/components/files/newer-version-dialog'
import { FilingPickers } from '#/components/files/viewer-sidebar'
import type { RecordDocument } from '#/components/files/types'
import { LabelHead, LedgerRow } from '#/components/ledger-section'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { MoreMenu } from '#/components/ui/more-menu'
import { Select } from '#/components/ui/select'
import {
  fileDocument,
  getDocumentPreview,
  getEmail,
  listMembers,
  listRecordDocuments,
  openEmailReply,
  setEmailAudience,
} from '#/lib/server-fns'
import type {
  EmailAttachment,
  EmailBody,
  EmailDetail,
  EmailParticipant,
  EmailPrivacy,
  EmailThreadLine,
  ReplyOpening,
} from '#/lib/server-fns'
import { draftStateOf } from '#/lib/email/compose'
import type { DraftState } from '#/lib/email/compose'
import { fileType } from '#/lib/documents/files-tab'
import { openModalId } from '#/lib/modal-search'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

/**
 * The email window: the subject and the thread's size in the bone head,
 * then who reads it, the earlier messages one line each, and the message
 * itself open with its body and files. Cancel is the one close.
 * - The body is the server's sanitized document in an iframe sandboxed with
 *   no scripts and no forms; popups are allowed so a link opens a new tab.
 * - Same-origin lets the window size the frame to its content; with no
 *   scripts in the frame and a CSP refusing every load, it grants nothing.
 * - A body private to someone else is a bone panel, never fetched.
 * - A body private by default says who reads it; its owner widens it from
 *   there, for `recordId` (the record it was opened from) or members.
 * - An earlier message's line opens that message in this window.
 * - Reply is the foot's primary: the draft grows under the message,
 *   which folds to one line.
 */
export function EmailDialog({
  id,
  recordId = null,
  onOpenChange,
}: {
  id: string | null
  recordId?: string | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={id !== null} onOpenChange={onOpenChange}>
      <DialogContent size="l">
        {id === null ? null : (
          <EmailWindow
            key={id}
            id={id}
            recordId={recordId}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The window opened from the page's own URL: `?modal=email&id=`.
 * Closing drops the two params and keeps the rest.
 */
export function EmailModal({ recordId = null }: { recordId?: string | null }) {
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  return (
    <EmailDialog
      id={openModalId(search, 'email')}
      recordId={recordId}
      onOpenChange={(open) => {
        if (!open)
          void navigate({
            to: '.',
            search: (prev) => ({ ...prev, modal: undefined, id: undefined }),
            replace: true,
            resetScroll: false,
          })
      }}
    />
  )
}

/** `10:42` on the reader's day, else `13 Oct, 18:40`. */
export function messageStamp(iso: string, today: string): string {
  return dayKey(iso) === today
    ? formatTime(iso)
    : `${formatDay(iso, today)}, ${formatTime(iso)}`
}

const plural = (n: number, noun: string) =>
  `${String(n)} ${noun}${n === 1 ? '' : 's'}`

/** A lane of the open message: `To`, `Cc`, `Via`, in sans 12 graphite. */
function Lane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 text-label text-graphite">
      <span className="w-10 shrink-0">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-0.5">
        {children}
      </span>
    </div>
  )
}

function Who({ p }: { p: EmailParticipant }) {
  return <span>{p.name ?? p.email}</span>
}

/** The sandboxed body, sized to what it holds. */
export function EmailFrame({ srcdoc }: { srcdoc: string }) {
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

function Body({ body, owner }: { body: EmailBody; owner: string }) {
  switch (body.kind) {
    case 'html':
      return (
        <div className="border border-rule p-4">
          <EmailFrame srcdoc={body.srcdoc} />
        </div>
      )
    case 'text':
      return (
        <div className="border border-rule p-4 text-body whitespace-pre-wrap">
          {body.text}
        </div>
      )
    case 'private':
      return (
        <p
          data-body-private
          className="border border-rule bg-bone px-4 py-6 text-center text-ui text-graphite"
        >
          Private to {owner}&rsquo;s mailbox
        </p>
      )
    case 'none':
      return <p className="px-3 py-2 text-ui text-graphite">No body.</p>
  }
}

function remoteLine(body: EmailBody): string | null {
  if (body.kind !== 'html' || body.remoteImages === 0) return null
  const n = body.remoteImages
  return `${String(n)} remote image${n === 1 ? '' : 's'} not loaded`
}

/** An attachment's mono end lane: `4.2 MB · Anish · 13 Oct`. */
export function attachmentLane(
  a: Pick<EmailAttachment, 'sizeBytes' | 'uploader' | 'addedAt'>,
  today: string,
): string {
  return [
    formatBytes(a.sizeBytes) || null,
    a.uploader,
    formatDay(a.addedAt, today),
  ]
    .filter((part) => part !== null && part !== '')
    .join(' · ')
}

/**
 * The privacy line's words and its one control: who reads the body, and
 * `Widen…` or `Change…` for its owner. A shared body (a forwarded one) is
 * read by the workspace and offers nothing.
 */
export function privacyLine(p: EmailPrivacy | null): {
  text: string
  control: 'Widen…' | 'Change…' | null
} {
  if (p === null) return { text: 'Visible to the workspace', control: null }
  if (p.workspace)
    return {
      text:
        p.record === null
          ? 'Visible to the workspace'
          : `Visible to the workspace · all your email with ${p.record.name}`,
      control: p.mine ? 'Change…' : null,
    }
  const names = [
    p.mine ? 'you' : p.owner.name,
    ...p.grantees.filter((g) => !(p.mine && g.you)).map((g) => g.name),
  ]
  return {
    text: `Visible to ${names.join(', ')}`,
    control: p.mine ? 'Widen…' : null,
  }
}

const CATEGORY_WORD = (c: string) => c.charAt(0).toUpperCase() + c.slice(1)

function PrivacyRow({
  email,
  onWiden,
}: {
  email: EmailDetail
  onWiden: () => void
}) {
  const { text, control } = privacyLine(email.privacy)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {email.categories.map((c) => (
        <span
          key={c}
          data-category={c}
          className="flex h-5 items-center rounded-md border border-rule px-1.5 text-label text-graphite"
        >
          {CATEGORY_WORD(c)}
        </span>
      ))}
      <p data-privacy className="text-label text-graphite">
        {text}
        {control === null ? null : (
          <>
            {'  '}
            <button
              type="button"
              onClick={onWiden}
              className="focus-ring text-foreground underline"
            >
              {control}
            </button>
          </>
        )}
      </p>
    </div>
  )
}

type Member = { id: string; name: string }

/**
 * Who can read this: the owner, the members granted this one email (each
 * removable), a member to add, and — opened from a record — every email
 * the owner has with it. Saving writes both at once.
 */
export function WidenDialog({
  emailId,
  privacy,
  open,
  onOpenChange,
  onSaved,
}: {
  emailId: string
  privacy: EmailPrivacy
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [members, setMembers] = useState<Array<Member> | null>(null)
  const [record, setRecord] = useState(privacy.record?.on ?? false)
  const [granted, setGranted] = useState<Array<Member>>(() =>
    privacy.grantees.map((g) => ({ id: g.id, name: g.name })),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRecord(privacy.record?.on ?? false)
    setGranted(privacy.grantees.map((g) => ({ id: g.id, name: g.name })))
    setError(null)
    let live = true
    listMembers()
      .then((rows) => {
        if (live)
          setMembers(rows.filter((m) => !m.banned && m.id !== privacy.owner.id))
      })
      .catch(() => {
        if (live) setMembers([])
      })
    return () => {
      live = false
    }
  }, [open, privacy])

  const addable = (members ?? []).filter(
    (m) => !granted.some((g) => g.id === m.id),
  )

  async function save() {
    setSaving(true)
    try {
      await setEmailAudience({
        data: {
          interactionId: emailId,
          userIds: granted.map((g) => g.id),
          record:
            privacy.record === null
              ? null
              : { id: privacy.record.id, workspace: record },
        },
      })
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="s" className="flex max-h-[70vh] flex-col">
        <DialogHeader>
          <DialogTitle>Who can read this</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          The members who read this email
        </DialogDescription>
        <div className="-mx-5 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5">
          <ol className="border-t border-rule">
            <LedgerRow last={granted.length === 0}>
              <span className="min-w-0 flex-1 truncate text-body">
                {privacy.owner.name}
              </span>
              <span className="shrink-0 mono text-micro text-graphite">
                Owner
              </span>
            </LedgerRow>
            {granted.map((g, i) => (
              <LedgerRow key={g.id} last={i === granted.length - 1}>
                <span className="min-w-0 flex-1 truncate text-body">
                  {g.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${g.name}`}
                  onClick={() =>
                    setGranted((prev) => prev.filter((p) => p.id !== g.id))
                  }
                  className="focus-ring shrink-0 text-graphite hover:text-foreground"
                >
                  <X className="size-3" strokeWidth={2} />
                </button>
              </LedgerRow>
            ))}
          </ol>
          {members === null ? (
            <Twinkle size={14} />
          ) : addable.length === 0 ? null : (
            <Select
              aria-label="Add a person"
              value=""
              onChange={(id) => {
                const m = addable.find((a) => a.id === id)
                if (m) setGranted((prev) => [...prev, m])
              }}
              items={addable.map((m) => ({ value: m.id, label: m.name }))}
              width="trigger"
              placeholder="Add a person…"
            />
          )}
          {privacy.record === null ? null : (
            <label className="flex items-center gap-2.5 text-ui">
              <Checkbox
                checked={record}
                onCheckedChange={setRecord}
                aria-label={`Every email I have with ${privacy.record.name}`}
              />
              Every email I have with {privacy.record.name}
            </label>
          )}
          {error === null ? null : (
            <p className="text-ui text-destructive">{error}</p>
          )}
        </div>
        <DialogFooter note="Subject, people and date stay visible to all">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} pending={saving}>
            Widen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** How many of the earliest lines fold, with more than two before the message. */
const SHOWN_EARLIER = 2

/** An earlier message: who, a graphite preview, its files, the stamp. */
function ThreadLine({
  line,
  today,
  onOpen,
}: {
  line: EmailThreadLine
  today: string
  onOpen: () => void
}) {
  return (
    <li>
      <button
        type="button"
        data-thread-line={line.id}
        onClick={onOpen}
        className="focus-ring-inset flex h-9 w-full items-center gap-3 border-b border-rule px-3 text-left hover:bg-bone"
      >
        <span className="w-40 shrink-0 truncate text-ui">
          {line.sent ? `To ${line.who}` : line.who}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-graphite">
          {line.preview ?? ''}
        </span>
        {line.attachments > 0 ? (
          <span className="flex shrink-0 items-center gap-1 mono text-micro text-graphite">
            <Paperclip
              aria-label="Attachments"
              className="size-3"
              strokeWidth={1.75}
            />
            {line.attachments}
          </span>
        ) : null}
        <span className="shrink-0 mono text-micro text-graphite">
          {messageStamp(line.occurredAt, today)}
        </span>
      </button>
    </li>
  )
}

function Thread({
  earlier,
  today,
  onOpen,
}: {
  earlier: ReadonlyArray<EmailThreadLine>
  today: string
  onOpen: (id: string) => void
}) {
  const [unfolded, setUnfolded] = useState(false)
  if (earlier.length === 0) return null
  const folded =
    !unfolded && earlier.length > SHOWN_EARLIER
      ? earlier.length - SHOWN_EARLIER
      : 0
  return (
    <ol aria-label="Earlier messages" className="border-t border-rule">
      {folded === 0 ? null : (
        <li>
          <button
            type="button"
            data-folded-earlier
            onClick={() => setUnfolded(true)}
            className="focus-ring-inset flex h-9 w-full items-center border-b border-rule px-3 text-left text-ui text-graphite hover:bg-bone hover:text-foreground"
          >
            {plural(folded, 'earlier message')}
          </button>
        </li>
      )}
      {earlier.slice(folded).map((line) => (
        <ThreadLine
          key={line.id}
          line={line}
          today={today}
          onOpen={() => onOpen(line.id)}
        />
      ))}
    </ol>
  )
}

/**
 * One attachment: the row opens the viewer over this window; its `···` has
 * Open, Download, File on… and — opened from a record — Newer version of….
 */
function AttachmentRow({
  a,
  last,
  today,
  recordId,
  onOpen,
  onFileOn,
  onNewer,
}: {
  a: EmailAttachment
  last: boolean
  today: string
  recordId: string | null
  onOpen: () => void
  onFileOn: () => void
  onNewer: () => void
}) {
  return (
    <LedgerRow last={last}>
      <button
        type="button"
        onClick={onOpen}
        className="focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left hover:bg-bone"
      >
        <FileGlyph
          type={fileType({
            filename: a.filename,
            mime: a.mime,
            externalUrl: null,
          })}
        />
        <span className="min-w-0 flex-1 truncate text-body">{a.name}</span>
        <span
          data-attachment-lane
          className="shrink-0 mono text-micro text-graphite"
        >
          {attachmentLane(a, today)}
        </span>
      </button>
      <MoreMenu
        variant="row"
        label={a.name}
        items={[
          { label: 'Open', opens: true, onSelect: onOpen },
          {
            label: 'Download',
            onSelect: () => void downloadDocument(a.documentId),
          },
          { label: 'File on…', opens: true, onSelect: onFileOn },
          ...(recordId === null
            ? []
            : [{ label: 'Newer version of…', opens: true, onSelect: onNewer }]),
        ]}
      />
    </LedgerRow>
  )
}

/** `File on…` for an attachment: the record search and the space tree. */
function FileOnDialog({
  attachment,
  onOpenChange,
}: {
  attachment: EmailAttachment | null
  onOpenChange: (open: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={attachment !== null} onOpenChange={onOpenChange}>
      <DialogContent size="s">
        <DialogHeader>
          <DialogTitle>File on…</DialogTitle>
          <DialogDescription className="min-w-0 truncate">
            {attachment?.name}
          </DialogDescription>
        </DialogHeader>
        {attachment === null ? null : (
          <FilingPickers
            filedIds={[]}
            disabled={busy}
            onPick={(target) => {
              setBusy(true)
              fileDocument({
                data: { documentId: attachment.documentId, target },
              })
                .then(() => {
                  toast('Filed')
                  onOpenChange(false)
                })
                .catch((err: unknown) => {
                  toast.error(
                    err instanceof Error ? err.message : 'Could not file it',
                  )
                })
                .finally(() => setBusy(false))
            }}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EmailWindow({
  id: openedId,
  recordId,
  onClose,
}: {
  id: string
  recordId: string | null
  onClose: () => void
}) {
  const { today } = useClock()
  const [id, setId] = useState(openedId)
  const [email, setEmail] = useState<EmailDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<Awaited<
    ReturnType<typeof getDocumentPreview>
  > | null>(null)
  const [widening, setWidening] = useState(false)
  const [filing, setFiling] = useState<EmailAttachment | null>(null)
  const [versioning, setVersioning] = useState<{
    doc: RecordDocument
    older: Array<RecordDocument>
  } | null>(null)
  const [reads, setReads] = useState(0)
  const [reply, setReply] = useState<{
    modes: ReplyOpening['modes']
    draft: DraftState
    savedAt: string | null
  } | null>(null)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [unfolded, setUnfolded] = useState(false)

  useEffect(() => {
    let live = true
    getEmail({ data: { id, recordId } })
      .then((e) => {
        if (live) setEmail(e)
      })
      .catch((err: unknown) => {
        if (live)
          setError(
            err instanceof Error ? err.message : 'Could not read the email',
          )
      })
    return () => {
      live = false
    }
  }, [id, recordId, reads])

  function openMessage(next: string) {
    setEmail(null)
    setReply(null)
    setId(next)
  }

  async function openAttachment(a: EmailAttachment) {
    const doc = await getDocumentPreview({ data: { id: a.documentId } })
    if (doc) setViewer(doc)
  }

  /** The record's other files of this kind, for `Newer version of…`. */
  async function newerVersion(a: EmailAttachment) {
    if (recordId === null) return
    try {
      const docs = await listRecordDocuments({ data: { entityId: recordId } })
      const doc = docs.find((d) => d.id === a.documentId)
      if (doc === undefined) {
        toast.error('File it on this record first')
        return
      }
      const older = docs.filter(
        (d) => d.id !== doc.id && d.kind === doc.kind && d.replacedBy === null,
      )
      if (older.length === 0) {
        toast.error('No other file of this kind on the record')
        return
      }
      setVersioning({ doc, older })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read files')
    }
  }

  async function startReply() {
    setReplyError(null)
    try {
      const opened = await openEmailReply({ data: { parentId: id } })
      setUnfolded(false)
      setReply(
        opened.draft === null
          ? {
              modes: opened.modes,
              draft: { ...opened.modes.reply, id: crypto.randomUUID() },
              savedAt: null,
            }
          : {
              modes: opened.modes,
              draft: draftStateOf(opened.draft),
              savedAt: opened.draft.updatedAt,
            },
      )
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : 'Could not reply')
    }
  }

  const foot = (
    <DialogFooter {...(replyError === null ? {} : { note: replyError })}>
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
      {email === null ? null : (
        <Button onClick={() => void startReply()}>Reply</Button>
      )}
    </DialogFooter>
  )

  if (email === null)
    return (
      <>
        <DialogHeader>
          <DialogTitle>Email</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          The email is being read
        </DialogDescription>
        {error === null ? (
          <div className="flex min-h-48 flex-1 items-center justify-center">
            <Twinkle size={29} />
          </div>
        ) : (
          <p className="text-ui text-destructive">{error}</p>
        )}
        {foot}
      </>
    )

  const remote = remoteLine(email.body)
  const isPrivate = email.body.kind === 'private'
  const owner = email.privacy?.owner.name ?? email.via ?? 'its owner'
  const message = (
    <>
      <PrivacyRow email={email} onWiden={() => setWidening(true)} />

      <Thread
        earlier={email.thread.earlier}
        today={today}
        onOpen={openMessage}
      />

      <section aria-label="Message" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            {email.from === null ? (
              <span className="text-ui text-graphite">Unknown sender</span>
            ) : (
              <>
                <span className="text-ui">
                  {email.from.name ?? email.from.email}
                </span>
                {email.from.name === null ? null : (
                  <span className="min-w-0 truncate mono text-micro text-graphite">
                    {email.from.email}
                  </span>
                )}
              </>
            )}
            <span className="ml-auto shrink-0 mono text-micro text-graphite">
              {messageStamp(email.occurredAt, today)}
            </span>
          </div>
          {isPrivate && email.from !== null ? (
            <Lane label="From">
              <Who p={email.from} />
            </Lane>
          ) : null}
          {email.to.length === 0 ? null : (
            <Lane label="To">
              {email.to.map((p) => (
                <Who key={p.email} p={p} />
              ))}
            </Lane>
          )}
          {email.cc.length === 0 ? null : (
            <Lane label="Cc">
              {email.cc.map((p) => (
                <Who key={p.email} p={p} />
              ))}
            </Lane>
          )}
          {email.bcc.length === 0 ? null : (
            <Lane label="Bcc">
              {email.bcc.map((p) => (
                <span
                  key={p.email}
                  data-bcc={p.email}
                  className="inline-flex items-baseline gap-1.5"
                >
                  <Who p={p} />
                  <span className="mono text-micro">hidden</span>
                </span>
              ))}
            </Lane>
          )}
          {email.via === null || isPrivate ? null : (
            <Lane label="Via">
              <span>{email.via}</span>
            </Lane>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Body body={email.body} owner={owner} />
          {remote === null ? null : (
            <span data-remote-images className="mono text-micro text-graphite">
              {remote}
            </span>
          )}
        </div>
      </section>

      {email.attachments.length === 0 ? null : (
        <section aria-label="Attachments" className="flex flex-col">
          <LabelHead
            label={`Attachments · ${String(email.attachments.length)}`}
          />
          <ol>
            {email.attachments.map((a, i) => (
              <AttachmentRow
                key={a.documentId}
                a={a}
                last={i === email.attachments.length - 1}
                today={today}
                recordId={recordId}
                onOpen={() => void openAttachment(a)}
                onFileOn={() => setFiling(a)}
                onNewer={() => void newerVersion(a)}
              />
            ))}
          </ol>
        </section>
      )}
    </>
  )
  const extras = (
    <>
      <DocumentPreview
        doc={viewer}
        onOpenChange={(open) => {
          if (!open) setViewer(null)
        }}
      />
      <FileOnDialog
        attachment={filing}
        onOpenChange={(open) => {
          if (!open) setFiling(null)
        }}
      />
      {versioning === null ? null : (
        <NewerVersionDialog
          doc={versioning.doc}
          older={versioning.older}
          open
          onOpenChange={(open) => {
            if (!open) setVersioning(null)
          }}
        />
      )}
      {email.privacy?.mine ? (
        <WidenDialog
          emailId={email.id}
          privacy={email.privacy}
          open={widening}
          onOpenChange={setWidening}
          onSaved={() => setReads((n) => n + 1)}
        />
      ) : null}
    </>
  )
  const head = (
    <DialogHeader>
      <DialogTitle>{email.subject || 'Untitled'}</DialogTitle>
      <DialogDescription className={cn(email.thread.messages < 2 && 'sr-only')}>
        {plural(email.thread.messages, 'message')}
      </DialogDescription>
    </DialogHeader>
  )

  if (reply !== null)
    return (
      <>
        {head}
        <DraftComposer
          key={reply.draft.id}
          initial={reply.draft}
          savedAt={reply.savedAt}
          modes={reply.modes}
          recordId={recordId}
          recordName={email.record?.name ?? null}
          onClose={() => setReply(null)}
          above={
            unfolded ? (
              <div className="flex flex-col gap-6 border-b border-rule px-5 py-4">
                {message}
              </div>
            ) : (
              <QuotedParent
                email={email}
                today={today}
                onShow={() => setUnfolded(true)}
              />
            )
          }
        />
        {extras}
      </>
    )

  return (
    <>
      {head}
      <div className="-mx-5 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5">
        {message}
      </div>
      {foot}
      {extras}
    </>
  )
}

/** The message a reply answers, folded to one line: `<name> wrote at 10:42 · Show`. */
function QuotedParent({
  email,
  today,
  onShow,
}: {
  email: EmailDetail
  today: string
  onShow: () => void
}) {
  const name = email.from?.name ?? email.from?.email ?? 'Someone'
  const at = messageStamp(email.occurredAt, today)
  return (
    <button
      type="button"
      data-folded-message
      onClick={onShow}
      className="focus-ring-inset flex min-h-10 w-full shrink-0 items-center gap-2 border-b border-rule px-5 text-left text-ui text-graphite hover:bg-bone"
    >
      <span className="text-foreground">{name}</span>
      wrote {dayKey(email.occurredAt) === today ? 'at' : 'on'} {at}
      <span aria-hidden>·</span>
      <span className="text-foreground underline">Show</span>
    </button>
  )
}
