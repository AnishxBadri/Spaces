import { Paperclip, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { parseVariables } from '@spaces/core/templates/variables'
import { formatTime } from '@spaces/core/format'
import { KeyHint } from '#/components/page-header'
import { SaveAsTemplateAction, TemplatePicker } from '#/components/templates'
import type { TemplateRow } from '#/components/templates'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { DialogFooter } from '#/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Tabs } from '#/components/ui/tabs'
import { uploadDocument } from '#/lib/documents/upload'
import {
  NO_CHOICES,
  openBlanks,
  recipientCount,
  saveInput,
  switchMode,
  useDraftAutosave,
} from '#/lib/email/compose'
import type { DraftState, ReviewChoices } from '#/lib/email/compose'
import {
  deleteEmailDraft,
  getEmailSender,
  getEmailTemplate,
  listRecordDocuments,
  reviewEmailVariables,
  saveEmailAsTemplate,
  saveEmailDraft,
  sendEmailDraft,
} from '#/lib/server-fns'
import type {
  DraftDocument,
  EmailSender,
  ReplyOpening,
  VariableReview,
} from '#/lib/server-fns'
import { AddressRow, RecipientLine } from './recipient-line'
import { VariableReviewTable } from './variable-review'

/**
 * The composer (inline under a message, or in its own window): the
 * address block, the subject, the body and the files, then the foot.
 * - Cc and Bcc open from the address block and are closed when empty.
 * - Autosaved after `AUTOSAVE_MS` of quiet; Cancel and closing keep the row.
 * - Trash deletes it. ⌘↵ anywhere in the composer is the primary, the one
 *   printed key.
 * - A draft with `{{variables}}` reviews before it sends: the primary is
 *   Review, and Send appears once no recipient's row has an open blank.
 * - Send saves the draft, then hands its id and Review's fills to the
 *   Gmail plugin and waits; a failure keeps the draft and shows Gmail's
 *   words. Without a mailbox that may send, the primary is the line that
 *   says which account to reconnect.
 */

type ReplyMode = keyof ReplyOpening['modes']

const MODE_TABS: ReadonlyArray<{ id: ReplyMode; label: string }> = [
  { id: 'reply', label: 'Reply' },
  { id: 'reply_all', label: 'Reply all' },
  { id: 'forward', label: 'Forward' },
]

/** `saved 09:16`, in the reader's clock. */
export function savedLine(iso: string | null): string | null {
  return iso === null ? null : `saved ${formatTime(iso)}`
}

const plural = (n: number, noun: string) =>
  `${String(n)} ${noun}${n === 1 ? '' : 's'}`

/** Review's fills as the send takes them: typed cells only. */
function typedFills(choices: ReviewChoices) {
  const out: Record<string, Record<string, string>> = {}
  for (const [email, row] of Object.entries(choices.fills)) {
    const cells: Record<string, string> = {}
    for (const [path, value] of Object.entries(row ?? {}))
      if (value !== undefined && value.trim() !== '') cells[path] = value
    out[email] = cells
  }
  return out
}

const COULD_NOT_READ: EmailSender = {
  _tag: 'unavailable',
  reason: 'Could not read your mailbox',
  href: null,
}

/** In the primary's place when there is nothing to send with. */
function SendBlocked({ sender }: { sender: EmailSender }) {
  if (sender._tag === 'ready') return null
  const href =
    sender._tag === 'reconnect'
      ? `/settings/email-calendar/${sender.connectionId}`
      : sender.href
  const words =
    sender._tag === 'reconnect' ? 'Reconnect Gmail to send' : sender.reason
  return href === null ? (
    <span data-send-blocked className="mono text-micro text-graphite">
      {words}
    </span>
  ) : (
    <a
      data-send-blocked
      href={href}
      className="focus-ring mono text-micro text-primary hover:underline"
    >
      {words} ›
    </a>
  )
}

export function DraftComposer({
  initial,
  savedAt: initialSavedAt = null,
  modes = null,
  recordId = null,
  above,
  onSaved,
  onClose,
}: {
  initial: DraftState
  /** When the row was last saved; null for a draft not yet written. */
  savedAt?: string | null
  /** A reply's three starts; given, the mode is a row of tabs. */
  modes?: ReplyOpening['modes'] | null
  /** The record it was opened from: whose files Attach offers. */
  recordId?: string | null
  /** What sits over the address block: the folded message, inline. */
  above?: ReactNode
  onSaved?: (at: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState(initialSavedAt)
  const [ccOpen, setCcOpen] = useState(initial.cc.length > 0)
  const [bccOpen, setBccOpen] = useState(initial.bcc.length > 0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<VariableReview | null>(null)
  const [choices, setChoices] = useState<ReviewChoices>(NO_CHOICES)
  const [reviewing, setReviewing] = useState(false)
  const [templating, setTemplating] = useState(false)
  const [sender, setSender] = useState<EmailSender | null>(null)
  const { confirm, confirmDialog } = useConfirm()
  const inflight = useRef<Promise<void>>(Promise.resolve())

  const save = (d: DraftState): Promise<void> => {
    const run = saveEmailDraft({ data: saveInput(d) })
      .then((r) => {
        setSavedAt(r.updatedAt)
        setError(null)
        onSaved?.(r.updatedAt)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not save')
      })
    inflight.current = run
    return run
  }
  const autosave = useDraftAutosave(draft, dirty, save)

  const parentId = initial.inReplyToId
  useEffect(() => {
    let live = true
    getEmailSender({ data: { parentId } })
      .then((s) => {
        if (live) setSender(s)
      })
      .catch(() => {
        if (live) setSender(COULD_NOT_READ)
      })
    return () => {
      live = false
    }
  }, [parentId])

  function edit(next: Partial<DraftState>) {
    setDraft((d) => ({ ...d, ...next }))
    setDirty(true)
  }

  function pickMode(mode: ReplyMode) {
    if (modes === null || draft.mode === 'new') return
    const from = modes[draft.mode]
    setDraft((d) => switchMode(d, from, modes[mode]))
    setDirty(true)
    setReview(null)
  }

  async function cancel() {
    await autosave.flush()
    onClose()
  }

  async function send() {
    setSending(true)
    autosave.cancel()
    await inflight.current
    try {
      const saved = await saveEmailDraft({ data: saveInput(draft) })
      setSavedAt(saved.updatedAt)
      onSaved?.(saved.updatedAt)
      const sent = await sendEmailDraft({
        data: {
          draftId: draft.id,
          fills: typedFills(choices),
          accepted: [...choices.accepted],
        },
      })
      toast(sent.sent === 1 ? 'Sent' : `Sent ${plural(sent.sent, 'email')}`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send')
      setSending(false)
    }
  }

  async function startReview() {
    setReviewing(true)
    await autosave.flush()
    try {
      const result = await reviewEmailVariables({
        data: {
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          bodyMd: draft.bodyMd,
        },
      })
      setError(null)
      setReview(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not review')
    } finally {
      setReviewing(false)
    }
  }

  /** Applying copies the template's subject, body and files; the recipients stay. */
  async function applyTemplate(t: TemplateRow) {
    const written =
      draft.subject.trim() !== '' ||
      draft.bodyMd.trim() !== '' ||
      draft.attachments.length > 0
    if (
      written &&
      !(await confirm({
        title: `Replace this draft with ${t.name}?`,
        body: 'The subject, the message and the files are replaced. The recipients stay.',
        action: 'Replace',
        kind: 'primary',
      }))
    )
      return
    try {
      const fill = await getEmailTemplate({ data: { id: t.id } })
      edit(fill)
      setReview(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply it')
    }
  }

  async function trash() {
    autosave.cancel()
    await inflight.current
    try {
      await deleteEmailDraft({ data: { id: draft.id } })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete')
    }
  }

  const n = recipientCount(draft)
  const files = draft.attachments.length
  const saved = savedLine(savedAt)
  const variables =
    parseVariables(`${draft.subject}\n${draft.bodyMd}`).length > 0
  const open =
    review === null
      ? 0
      : review.rows.reduce((sum, r) => sum + openBlanks(r, choices).length, 0)
  const sendable = review === null ? !variables : open === 0
  const busy = sending || reviewing
  const blocked = sender !== null && sender._tag !== 'ready'

  function primary() {
    if (busy || blocked || sender === null) return
    if (sendable) void send()
    else if (review === null) void startReview()
  }

  const tools = (
    <span className="flex shrink-0 items-center gap-1">
      <TemplatePicker
        kind="email"
        context="email"
        onPick={(t) => void applyTemplate(t)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="More for this draft"
          >
            <span aria-hidden className="mono text-ui">
              ···
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48"
          onCloseAutoFocus={(e) => {
            if (templating) e.preventDefault()
          }}
        >
          <DropdownMenuItem onSelect={() => setTemplating(true)}>
            Save as template…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )

  return (
    <>
      <div
        className="-mx-5 flex min-h-0 flex-1 flex-col overflow-y-auto"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            primary()
          }
        }}
      >
        {review === null ? above : null}
        {modes === null || draft.mode === 'new' ? (
          <div className="flex h-9 shrink-0 items-center justify-end border-b border-rule px-3">
            {tools}
          </div>
        ) : (
          <Tabs
            items={MODE_TABS}
            value={draft.mode}
            onValueChange={pickMode}
            label="Reply mode"
            trail={
              <span className="ml-auto flex items-center gap-1">
                {saved === null ? null : (
                  <span
                    data-saved
                    className="pr-2 mono text-micro text-graphite"
                  >
                    {saved}
                  </span>
                )}
                {tools}
              </span>
            }
          />
        )}
        {review === null ? null : (
          <VariableReviewTable
            review={review}
            choices={choices}
            onChange={setChoices}
          />
        )}
        <div
          className={
            review === null ? 'flex min-h-0 flex-1 flex-col' : 'hidden'
          }
        >
          <section aria-label="Addresses" className="flex flex-col">
            <RecipientLine
              label="To"
              value={draft.to}
              onChange={(to) => edit({ to })}
              autoFocus={draft.to.length === 0}
              trail={
                ccOpen && bccOpen ? undefined : (
                  <span className="flex shrink-0 items-center gap-1 mono text-micro text-graphite">
                    {ccOpen ? null : (
                      <button
                        type="button"
                        onClick={() => setCcOpen(true)}
                        className="focus-ring hover:text-foreground"
                      >
                        cc
                      </button>
                    )}
                    {ccOpen || bccOpen ? null : <span aria-hidden>·</span>}
                    {bccOpen ? null : (
                      <button
                        type="button"
                        onClick={() => setBccOpen(true)}
                        className="focus-ring hover:text-foreground"
                      >
                        bcc
                      </button>
                    )}
                  </span>
                )
              }
            />
            {ccOpen ? (
              <RecipientLine
                label="Cc"
                value={draft.cc}
                onChange={(cc) => edit({ cc })}
              />
            ) : null}
            {bccOpen ? (
              <RecipientLine
                label="Bcc"
                value={draft.bcc}
                onChange={(bcc) => edit({ bcc })}
                blind
              />
            ) : null}
            <AddressRow label="Subject" htmlFor={`subject-${draft.id}`}>
              <input
                id={`subject-${draft.id}`}
                value={draft.subject}
                onChange={(e) => edit({ subject: e.target.value })}
                className="h-6 w-full bg-transparent text-ui outline-none"
              />
            </AddressRow>
          </section>
          <textarea
            aria-label="Message"
            value={draft.bodyMd}
            autoFocus={draft.to.length > 0}
            onChange={(e) => edit({ bodyMd: e.target.value })}
            className="text-prose min-h-48 w-full flex-1 resize-none bg-paper px-5 py-4 font-serif leading-6.75 outline-none"
          />
          <Attachments
            files={draft.attachments}
            recordId={recordId}
            onChange={(attachments) => edit({ attachments })}
          />
        </div>
        {error === null ? null : (
          <p role="alert" className="px-5 pb-3 text-ui text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          className="mr-auto"
          onClick={() => void trash()}
        >
          Trash
        </Button>
        <span className="mono text-micro text-graphite">
          {plural(n, 'recipient')}
          {files > 0 ? ` · ${plural(files, 'file')}` : ''}
        </span>
        {review === null ? (
          <Button type="button" variant="outline" onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => setReview(null)}
          >
            Back
          </Button>
        )}
        {sender !== null && blocked ? (
          <SendBlocked sender={sender} />
        ) : sendable ? (
          <Button
            type="button"
            pending={sending}
            disabled={busy || sender === null}
            onClick={primary}
          >
            {sending ? 'Sending…' : 'Send'}
            <KeyHint>⌘↵</KeyHint>
          </Button>
        ) : review === null ? (
          <Button
            type="button"
            pending={reviewing}
            disabled={busy || sender === null}
            onClick={primary}
          >
            Review
            <KeyHint>⌘↵</KeyHint>
          </Button>
        ) : (
          <span data-open-blanks className="mono text-micro text-destructive">
            {open === 1 ? '1 blank to fill' : `${String(open)} blanks to fill`}
          </span>
        )}
      </DialogFooter>
      {templating ? (
        <SaveAsTemplateAction
          entityLabel="email"
          defaultName={draft.subject}
          open
          onOpenChange={setTemplating}
          onSave={async (name) => {
            await saveEmailAsTemplate({
              data: {
                name,
                subject: draft.subject,
                bodyMd: draft.bodyMd,
                attachments: saveInput(draft).attachments,
              },
            })
          }}
        />
      ) : null}
      {confirmDialog}
    </>
  )
}

type RecordFile = { id: string; filename: string | null }

/**
 * The files the draft carries, and Attach: one of the record's files, or an
 * upload — filed on that record when there is one.
 */
function Attachments({
  files,
  recordId,
  onChange,
}: {
  files: ReadonlyArray<DraftDocument>
  recordId: string | null
  onChange: (next: Array<DraftDocument>) => void
}) {
  const [open, setOpen] = useState(false)
  const [recordFiles, setRecordFiles] = useState<Array<RecordFile> | null>(null)
  const [uploading, setUploading] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || recordId === null) return
    let live = true
    listRecordDocuments({ data: { entityId: recordId } })
      .then((rows) => {
        if (live) setRecordFiles(rows)
      })
      .catch(() => {
        if (live) setRecordFiles([])
      })
    return () => {
      live = false
    }
  }, [open, recordId])

  const add = (doc: DraftDocument) =>
    onChange(
      files.some((f) => f.documentId === doc.documentId)
        ? [...files]
        : [...files, doc],
    )

  async function upload(file: File) {
    setUploading(true)
    try {
      const born = await uploadDocument({
        file,
        fileAgainst:
          recordId === null ? [] : [{ kind: 'record', entityId: recordId }],
        onPhase: () => {},
      })
      add({ documentId: born.id, name: file.name })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const offered = (recordFiles ?? []).filter(
    (f) => !files.some((a) => a.documentId === f.id),
  )

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-5 pb-4">
      {files.map((f) => (
        <span
          key={f.documentId}
          data-attachment={f.documentId}
          className="flex h-6 items-center gap-1.5 border border-rule bg-paper px-2 text-ui"
        >
          <Paperclip className="size-3 text-graphite" strokeWidth={1.75} />
          {f.name}
          <button
            type="button"
            aria-label={`Remove ${f.name}`}
            onClick={() =>
              onChange(files.filter((a) => a.documentId !== f.documentId))
            }
            className="focus-ring text-graphite hover:text-foreground"
          >
            <X className="size-2.5" strokeWidth={2} />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={uploading}
            className="focus-ring flex h-6 items-center gap-1 border border-dashed border-rule px-2 text-ui text-graphite hover:text-foreground"
          >
            {uploading ? 'Uploading…' : '+ Attach'}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex flex-col gap-1 p-1">
          {offered.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                add({ documentId: f.id, name: f.filename ?? 'Untitled' })
                setOpen(false)
              }}
              className="focus-ring-inset flex h-7 items-center px-2 text-left text-ui hover:bg-bone"
            >
              <span className="truncate">{f.filename ?? 'Untitled'}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              picker.current?.click()
            }}
            className="focus-ring-inset flex h-7 items-center px-2 text-left text-ui hover:bg-bone"
          >
            Upload a file…
          </button>
        </PopoverContent>
      </Popover>
      <input
        ref={picker}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.item(0)
          e.target.value = ''
          if (file) void upload(file)
        }}
      />
    </div>
  )
}
