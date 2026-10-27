import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { formatBytes } from '@spaces/core/documents'
import { parseVariables } from '@spaces/core/templates/variables'
import { formatTime } from '@spaces/core/format'
import { FileGlyph } from '#/components/files/file-glyph'
import { SaveAsTemplateAction, TemplatePicker } from '#/components/templates'
import type { TemplateRow } from '#/components/templates'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { DialogFooter } from '#/components/ui/dialog'
import { MoreMenu } from '#/components/ui/more-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Segmented } from '#/components/ui/segmented'
import { fileType } from '#/lib/documents/files-tab'
import { uploadDocument } from '#/lib/documents/upload'
import {
  NO_CHOICES,
  openBlanks,
  saveInput,
  switchMode,
  useDraftAutosave,
} from '#/lib/email/compose'
import type { DraftState, ReviewChoices } from '#/lib/email/compose'
import {
  deleteEmailDraft,
  getEmailSender,
  getEmailTemplate,
  listEmailVariables,
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
  VariableOption,
  VariableReview,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { AddressRow, RecipientLine } from './recipient-line'
import { ReviewPanes } from './variable-review'

/**
 * The composer (inline under a message, or in its own window): the mode,
 * the address block, the subject, the body and the files, the tool row,
 * then the foot.
 * - Cc and Bcc open from the address block and are closed when empty.
 * - Autosaved after `AUTOSAVE_MS` of quiet; Cancel and closing keep the row;
 *   `Delete draft…` in the tool row's `···` deletes it.
 * - A draft with `{{variables}}` is reviewed before it sends: the primary is
 *   Review and send, and Send appears once no recipient has an open blank.
 * - Send saves the draft, then hands its id and Review's fills to the
 *   Gmail plugin and waits, the draft greyed; a failure keeps the draft and
 *   says why. A mailbox that asks to sign in again makes the primary
 *   Reconnect Gmail. ⌘↵ is the primary, in its tooltip.
 */

type ReplyMode = keyof ReplyOpening['modes']

const MODE_OPTIONS: ReadonlyArray<{ id: ReplyMode; label: string }> = [
  { id: 'reply', label: 'Reply' },
  { id: 'reply_all', label: 'Reply all' },
  { id: 'forward', label: 'Forward' },
]

/** `Saved 09:16`, in the reader's clock. */
export function savedLine(iso: string | null): string | null {
  return iso === null ? null : `Saved ${formatTime(iso)}`
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

const reconnectHref = (connectionId: string) =>
  `/settings/email-calendar/${connectionId}`

/** In the primary's place when there is no mailbox to send with. */
function SendBlocked({
  sender,
}: {
  sender: Extract<EmailSender, { _tag: 'unavailable' }>
}) {
  return sender.href === null ? (
    <span data-send-blocked className="mono text-micro text-graphite">
      {sender.reason}
    </span>
  ) : (
    <a
      data-send-blocked
      href={sender.href}
      className="focus-ring mono text-micro text-primary hover:underline"
    >
      {sender.reason} ›
    </a>
  )
}

/** What the last send said: why it did not go, and whether to reconnect. */
type Failure = { message: string; reconnect: string | null }

export function DraftComposer({
  initial,
  savedAt: initialSavedAt = null,
  modes = null,
  recordId = null,
  recordName = null,
  above,
  onSaved,
  onClose,
}: {
  initial: DraftState
  /** When the row was last saved; null for a draft not yet written. */
  savedAt?: string | null
  /** A reply's three starts; given, the mode is a Segmented. */
  modes?: ReplyOpening['modes'] | null
  /** The record it was opened from: whose files Attach offers. */
  recordId?: string | null
  /** That record's name, for `or a file from <record>`. */
  recordName?: string | null
  /** What sits over the address block: the quoted parent, inline. */
  above?: ReactNode
  onSaved?: (at: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState(initialSavedAt)
  const [saving, setSaving] = useState(false)
  const [ccOpen, setCcOpen] = useState(initial.cc.length > 0)
  const [bccOpen, setBccOpen] = useState(initial.bcc.length > 0)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<VariableReview | null>(null)
  const [choices, setChoices] = useState<ReviewChoices>(NO_CHOICES)
  const [reviewing, setReviewing] = useState(false)
  const [templating, setTemplating] = useState(false)
  const [sender, setSender] = useState<EmailSender | null>(null)
  const { confirm, confirmDialog } = useConfirm()
  const inflight = useRef<Promise<void>>(Promise.resolve())
  const body = useRef<HTMLTextAreaElement>(null)

  const save = (d: DraftState): Promise<void> => {
    setSaving(true)
    const run = saveEmailDraft({ data: saveInput(d) })
      .then((r) => {
        setSavedAt(r.updatedAt)
        setError(null)
        onSaved?.(r.updatedAt)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not save')
      })
      .finally(() => setSaving(false))
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

  /** `{{path}}` written where the caret is in the body. */
  function insertVariable(path: string) {
    const token = `{{${path}}}`
    const el = body.current
    const start = el?.selectionStart ?? draft.bodyMd.length
    const end = el?.selectionEnd ?? start
    edit({
      bodyMd: draft.bodyMd.slice(0, start) + token + draft.bodyMd.slice(end),
    })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  async function cancel() {
    await autosave.flush()
    onClose()
  }

  async function send() {
    setSending(true)
    setFailure(null)
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
      // A refused token reads the mailbox again: it now asks to reconnect.
      const now = await getEmailSender({ data: { parentId } }).catch(() => null)
      if (now !== null) setSender(now)
      setFailure(
        now?._tag === 'reconnect'
          ? {
              message: 'Gmail asks you to sign in again · the draft is kept',
              reconnect: now.connectionId,
            }
          : {
              // The server's sentence already says the draft is kept.
              message: err instanceof Error ? err.message : 'Could not send',
              reconnect: null,
            },
      )
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

  async function deleteDraft() {
    if (
      !(await confirm({
        title: 'Delete this draft?',
        body: 'What you wrote here goes.',
        action: 'Delete',
        kind: 'destructive',
      }))
    )
      return
    autosave.cancel()
    await inflight.current
    try {
      await deleteEmailDraft({ data: { id: draft.id } })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete')
    }
  }

  const saved = saving ? 'Saving…' : savedLine(savedAt)
  const variables =
    parseVariables(`${draft.subject}\n${draft.bodyMd}`).length > 0
  const open =
    review === null
      ? 0
      : review.rows.reduce((sum, r) => sum + openBlanks(r, choices).length, 0)
  const sendable = review === null ? !variables : open === 0
  const busy = sending || reviewing
  const reconnect =
    failure?.reconnect ??
    (sender?._tag === 'reconnect' ? sender.connectionId : null)
  const fromOriginal = new Set(
    draft.mode === 'forward' && modes !== null
      ? modes.forward.attachments.map((a) => a.documentId)
      : [],
  )

  function primary() {
    if (busy || sender === null || sender._tag !== 'ready') return
    if (sendable) void send()
    else if (review === null) void startReview()
  }

  const note: ReactNode = sending ? (
    <span data-sending className="flex items-center gap-2">
      <Twinkle size={14} />
      Through your Gmail
    </span>
  ) : failure !== null ? (
    <span data-send-failed className="text-destructive">
      ■ Not sent · {failure.message}
    </span>
  ) : review !== null ? (
    "Can't be unsent · goes at once"
  ) : null

  return (
    <>
      <div
        className={cn(
          '-mx-5 flex min-h-0 flex-1 flex-col overflow-y-auto',
          sending && 'pointer-events-none opacity-50',
        )}
        {...(sending ? { 'aria-busy': true } : {})}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            primary()
          }
        }}
      >
        {review === null ? above : null}
        {modes === null || draft.mode === 'new' ? null : (
          <div className="flex h-11 shrink-0 items-center gap-3 border-b border-rule px-5">
            <Segmented
              label="Reply mode"
              value={draft.mode}
              options={MODE_OPTIONS}
              onChange={pickMode}
            />
            {saved === null ? null : (
              <span
                data-saved
                className="ml-auto mono text-micro text-graphite"
              >
                {saved}
              </span>
            )}
          </div>
        )}
        {review === null ? null : (
          <ReviewPanes
            review={review}
            choices={choices}
            onChange={setChoices}
            subject={draft.subject}
            bodyMd={draft.bodyMd}
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
                  <span className="flex shrink-0 items-center gap-2.5 text-label text-graphite">
                    {ccOpen ? null : (
                      <button
                        type="button"
                        onClick={() => setCcOpen(true)}
                        className="focus-ring hover:text-foreground"
                      >
                        Cc
                      </button>
                    )}
                    {bccOpen ? null : (
                      <button
                        type="button"
                        onClick={() => setBccOpen(true)}
                        className="focus-ring hover:text-foreground"
                      >
                        Bcc
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
            ref={body}
            aria-label="Message"
            value={draft.bodyMd}
            autoFocus={draft.to.length > 0}
            onChange={(e) => edit({ bodyMd: e.target.value })}
            className="text-prose min-h-48 w-full flex-1 resize-none bg-paper px-5 py-4 font-serif leading-6.75 outline-none"
          />
          <Attachments
            files={draft.attachments}
            fromOriginal={fromOriginal}
            recordId={recordId}
            recordName={recordName}
            onChange={(attachments) => edit({ attachments })}
          />
          <div
            data-tool-row
            className="flex h-9 shrink-0 items-center gap-1 border-t border-rule px-3"
          >
            <TemplatePicker
              kind="email"
              context="email"
              align="start"
              onPick={(t) => void applyTemplate(t)}
              trigger={
                <button
                  type="button"
                  className="focus-ring flex h-7 items-center rounded-md px-2 text-label text-graphite hover:bg-bone hover:text-foreground"
                >
                  Template
                </button>
              }
            />
            <VariablePicker onPick={insertVariable} />
            <MoreMenu
              variant="row"
              label="this draft"
              items={[
                {
                  label: 'Save as template…',
                  opens: true,
                  onSelect: () => setTemplating(true),
                },
                {
                  label: 'Delete draft…',
                  opens: true,
                  destructive: true,
                  onSelect: () => void deleteDraft(),
                },
              ]}
            />
          </div>
        </div>
        {error === null ? null : (
          <p role="alert" className="px-5 pb-3 text-ui text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter note={note}>
        {review === null ? (
          <Button
            type="button"
            variant="outline"
            disabled={sending}
            onClick={() => void cancel()}
          >
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={sending}
            onClick={() => setReview(null)}
          >
            Back to draft
          </Button>
        )}
        {reconnect !== null ? (
          <Button asChild>
            <a data-reconnect href={reconnectHref(reconnect)}>
              Reconnect Gmail
            </a>
          </Button>
        ) : sender !== null && sender._tag === 'unavailable' ? (
          <SendBlocked sender={sender} />
        ) : sendable ? (
          <Button
            type="button"
            shortcut="⌘↵"
            pending={sending}
            disabled={busy || sender === null}
            onClick={primary}
          >
            Send
          </Button>
        ) : review === null ? (
          <Button
            type="button"
            shortcut="⌘↵"
            pending={reviewing}
            disabled={busy || sender === null}
            onClick={primary}
          >
            Review and send
          </Button>
        ) : null}
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

/**
 * `Variable`: the paths of the shared grammar — the person's name parts,
 * their company, the stats, then their attributes — and a pick writes
 * `{{path}}` into the body.
 */
function VariablePicker({ onPick }: { onPick: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<Array<VariableOption> | null>(null)

  useEffect(() => {
    if (!open || options !== null) return
    let live = true
    listEmailVariables()
      .then((rows) => {
        if (live) setOptions(rows)
      })
      .catch(() => {
        if (live) setOptions([])
      })
    return () => {
      live = false
    }
  }, [open, options])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="focus-ring flex h-7 items-center rounded-md px-2 text-label text-graphite hover:bg-bone hover:text-foreground"
        >
          Variable
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-72 w-64 flex-col overflow-y-auto p-1"
      >
        {options === null ? (
          <span className="flex h-7 items-center px-2">
            <Twinkle size={14} />
          </span>
        ) : (
          options.map((o) => (
            <button
              key={o.path}
              type="button"
              data-variable-option={o.path}
              onClick={() => {
                onPick(o.path)
                setOpen(false)
              }}
              className="focus-ring-inset flex h-7 shrink-0 items-center gap-3 px-2 text-left text-ui hover:bg-bone"
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              <span className="shrink-0 mono text-micro text-graphite">
                {o.path}
              </span>
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The files the draft carries — a glyph, the name and a mono size, `From
 * original` on a forward's own — and Attach: one of the record's files, or
 * an upload, filed on that record when there is one.
 */
function Attachments({
  files,
  fromOriginal,
  recordId,
  recordName,
  onChange,
}: {
  files: ReadonlyArray<DraftDocument>
  fromOriginal: ReadonlySet<string>
  recordId: string | null
  recordName: string | null
  onChange: (next: Array<DraftDocument>) => void
}) {
  const [open, setOpen] = useState(false)
  const [recordFiles, setRecordFiles] = useState<Array<DraftDocument> | null>(
    null,
  )
  const [uploading, setUploading] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || recordId === null) return
    let live = true
    listRecordDocuments({ data: { entityId: recordId } })
      .then((rows) => {
        if (live)
          setRecordFiles(
            rows.map((r) => ({
              documentId: r.id,
              name: r.filename,
              mime: r.mime,
              sizeBytes: r.sizeBytes,
            })),
          )
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
      add({
        documentId: born.id,
        name: file.name,
        mime: file.type === '' ? null : file.type,
        sizeBytes: file.size,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const offered = (recordFiles ?? []).filter(
    (f) => !files.some((a) => a.documentId === f.documentId),
  )

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-5 pb-4">
      {files.map((f) => (
        <span
          key={f.documentId}
          data-attachment={f.documentId}
          className="flex h-6 items-center gap-1.5 border border-rule bg-paper px-2 text-ui"
        >
          <FileGlyph
            type={fileType({
              filename: f.name,
              mime: f.mime,
              externalUrl: null,
            })}
          />
          {f.name}
          {f.sizeBytes === null ? null : (
            <span className="mono text-micro text-graphite">
              {formatBytes(f.sizeBytes)}
            </span>
          )}
          {fromOriginal.has(f.documentId) ? (
            <span data-from-original className="mono text-micro text-graphite">
              From original
            </span>
          ) : null}
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
            {uploading ? (
              <>
                <Twinkle size={14} />
                Uploading
              </>
            ) : recordName === null ? (
              '+ Attach'
            ) : (
              `+ Attach · or a file from ${recordName}`
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex flex-col gap-1 p-1">
          {offered.map((f) => (
            <button
              key={f.documentId}
              type="button"
              onClick={() => {
                add(f)
                setOpen(false)
              }}
              className="focus-ring-inset flex h-7 items-center px-2 text-left text-ui hover:bg-bone"
            >
              <span className="truncate">{f.name}</span>
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
