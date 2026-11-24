import { Attachment, icon } from '#/components/icons'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { formatBytes } from '@spaces/core/documents'
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
  choicesOf,
  messageCount,
  openBlankCount,
  reconnectHref,
  reviewCopies,
  saveInput,
  sendLabel,
  switchMode,
  useDraftAutosave,
  withChoices,
  withTemplate,
  useDraftsChanged,
} from '#/lib/email/compose'
import type { DraftHome, DraftState, ReviewChoices } from '#/lib/email/compose'
import { SIGN_IN_AGAIN } from '#/lib/email/send-words'
import { bodyWritten } from '#/lib/email/signature'
import {
  getEmailSender,
  getEmailSignature,
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
import { useDeleteDraft } from './delete-draft'
import { AddressRow, RecipientLine } from './recipient-line'
import { ReviewPanes } from './variable-review'

/**
 * The composer (the last card of a thread, the Email page's pane, or its
 * own window): the mode, the address block, the subject, the body and the
 * files, the tool row, then the foot.
 * - Cc and Bcc open from the address block and are closed when empty.
 * - Autosaved after `AUTOSAVE_MS` of quiet; Cancel and closing keep the row;
 *   `Delete draft…` in the tool row's `···` deletes it.
 * - Every send passes Review: the primary is Review, which shows the email
 *   as the card it will become (`ReviewPanes`), a copy per To recipient when
 *   it has variables. Review's primary counts what goes (`Send 3 emails`)
 *   and stays off while a blank is open. Its fills live on the To chips, so
 *   they are saved with the draft.
 * - A draft is reviewed without a mailbox; the send is not. Where Send
 *   would stand, Review's foot links to connecting Gmail, or is Reconnect
 *   Gmail when the mailbox asks to sign in again.
 * - Send saves the draft, then hands its id and Review's fills to the
 *   Gmail plugin and waits: the primary twinkles `Sending`, the draft greyed
 *   and `Back to draft` off. A failure keeps Review open, says
 *   `■ Not sent ·` and why, and the primary becomes `Retry`, or `Reconnect
 *   Gmail` when the mailbox asks to sign in again. Reconnect runs Google's
 *   consent and comes back to this draft open on Review (`home`). A draft
 *   reopened after a failure says so in its foot until it is sent or
 *   deleted. ⌘↵ is the primary, in its tooltip.
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

/** The author's signature, or none when it cannot be read: a template still applies. */
async function readSignature(): Promise<string> {
  try {
    return await getEmailSignature()
  } catch {
    return ''
  }
}

const COULD_NOT_READ: EmailSender = {
  _tag: 'unavailable',
  reason: 'Could not read your mailbox',
  href: null,
}

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

/** `■ Not sent ·` and why, crimson, at the foot's left. */
function NotSent({ message }: { message: string }) {
  return (
    <span
      data-send-failed
      className="flex items-center gap-2 font-sans text-label text-destructive"
    >
      <span aria-hidden className="size-2 shrink-0 bg-destructive" />
      Not sent · {message}
    </span>
  )
}

export function DraftComposer({
  initial,
  savedAt: initialSavedAt = null,
  modes = null,
  recordId = null,
  recordName = null,
  above,
  card = false,
  notSent = null,
  home = 'here',
  reconnected = false,
  onSaved,
  onSubject,
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
  /** What sits over the draft: the thread's cards, inline. */
  above?: ReactNode
  /**
   * The draft as the last card of a thread, in ink on the bone ground of a
   * flush window, rather than edge to edge in a window of its own.
   */
  card?: boolean
  /** Why its last send did not go, as stored on the draft. */
  notSent?: string | null
  /** Where Reconnect Gmail's consent comes back to. */
  home?: DraftHome
  /** Back from Reconnect Gmail: open on Review, the old failure not said. */
  reconnected?: boolean
  onSaved?: (at: string) => void
  /** The subject as typed, for a window head that prints it. */
  onSubject?: (subject: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState(initialSavedAt)
  const [saving, setSaving] = useState(false)
  const [ccOpen, setCcOpen] = useState(initial.cc.length > 0)
  const [bccOpen, setBccOpen] = useState(initial.bcc.length > 0)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(
    reconnected ? null : notSent,
  )
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<VariableReview | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [templating, setTemplating] = useState(false)
  const [sender, setSender] = useState<EmailSender | null>(null)
  const { confirm, confirmDialog } = useConfirm()
  const deleting = useDeleteDraft()
  // Review's fills and accepted blanks ride on the To chips, saved with the draft.
  const choices = choicesOf(draft.to)
  const setChoices = (next: ReviewChoices) =>
    edit({ to: withChoices(draft.to, next) })
  const inflight = useRef<Promise<void>>(Promise.resolve())
  const body = useRef<HTMLTextAreaElement>(null)
  const draftsChanged = useDraftsChanged()

  const save = (d: DraftState): Promise<void> => {
    setSaving(true)
    const run = saveEmailDraft({ data: saveInput(d) })
      .then((r) => {
        setSavedAt(r.updatedAt)
        setError(null)
        onSaved?.(r.updatedAt)
        draftsChanged()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not save')
      })
      .finally(() => setSaving(false))
    inflight.current = run
    return run
  }
  const autosave = useDraftAutosave(draft, dirty, save)

  const subjectTo = useRef(onSubject)
  subjectTo.current = onSubject
  useEffect(() => {
    subjectTo.current?.(draft.subject)
  }, [draft.subject])

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
      // Counted now: a refused send keeps the draft.
      draftsChanged()
      const settled = choicesOf(draft.to)
      const sent = await sendEmailDraft({
        data: {
          draftId: draft.id,
          fills: typedFills(settled),
          accepted: [...settled.accepted],
        },
      })
      draftsChanged()
      toast(sent.sent === 1 ? 'Sent' : `Sent ${plural(sent.sent, 'email')}`)
      onClose()
    } catch (err) {
      // A refused token reads the mailbox again: it now asks to reconnect.
      const now = await getEmailSender({ data: { parentId } }).catch(() => null)
      if (now !== null) setSender(now)
      setFailure(
        now?._tag === 'reconnect'
          ? SIGN_IN_AGAIN
          : err instanceof Error
            ? err.message
            : 'Could not send',
      )
      // The draft now leads Drafts as not sent.
      draftsChanged()
      setSending(false)
    }
  }

  // Back from Google's consent: straight to Review, where Send now stands.
  const landing = useRef(reconnected)
  useEffect(() => {
    if (!landing.current) return
    landing.current = false
    void startReview()
  })

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

  /**
   * Applying copies the template's subject, body and files; the recipients
   * stay, and so does the signature at the foot. A body holding only the
   * signature is not yet written, so it is replaced without asking.
   */
  async function applyTemplate(t: TemplateRow) {
    const signature = await readSignature()
    const written =
      draft.subject.trim() !== '' ||
      bodyWritten(draft.bodyMd, signature) ||
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
      setDraft((d) => withTemplate(d, fill, signature))
      setDirty(true)
      setReview(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply it')
    }
  }

  async function deleteDraft() {
    try {
      const gone = await deleting.deleteDraft(draft.id, async () => {
        autosave.cancel()
        await inflight.current
      })
      if (gone) onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete')
    }
  }

  const saved = saving ? 'Saving…' : savedLine(savedAt)
  // A reply's mode row carries the saved line; without it, the foot does.
  const modeRow = modes !== null && draft.mode !== 'new'
  const copies =
    review === null
      ? []
      : reviewCopies(review.rows, draft.to, review.paths.length > 0)
  const open = openBlankCount(copies, choices)
  const busy = sending || reviewing
  const reconnect = sender?._tag === 'reconnect' ? sender.from : null
  const ready = sender?._tag === 'ready'
  const fromOriginal = new Set(
    draft.mode === 'forward' && modes !== null
      ? modes.forward.attachments.map((a) => a.documentId)
      : [],
  )

  function primary() {
    if (busy) return
    if (review === null) void startReview()
    else if (ready && open === 0) void send()
  }

  const note: ReactNode = sending ? null : failure !== null ? (
    <NotSent message={failure} />
  ) : review !== null || modeRow || saved === null ? null : (
    // Without the mode row, the foot is where the save is told.
    <span data-saved>{saved}</span>
  )
  const sendFrom =
    sender === null || sender._tag === 'unavailable' ? null : sender.from

  return (
    <>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-y-auto',
          card ? 'gap-2 bg-bone p-3' : '-mx-4',
          // Review's bone runs from the window's head to its foot.
          !card &&
            review !== null &&
            'bg-bone in-data-[slot=dialog-content]:-mt-4',
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
        {above}
        {review === null ? null : (
          <ReviewPanes
            review={review}
            draft={draft}
            choices={choices}
            onChange={setChoices}
            from={sendFrom}
            card={card}
          />
        )}
        <div
          {...(card ? { 'data-draft-card': '' } : {})}
          className={cn(
            card
              ? 'flex shrink-0 flex-col border border-hairline bg-paper'
              : 'contents',
            // Held while Review shows, so going back finds it as it was.
            review !== null && 'hidden',
          )}
        >
          {modes === null || draft.mode === 'new' ? null : (
            <div className="flex h-11 shrink-0 items-center gap-3 border-b border-rule px-4">
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
          <div
            className={card ? 'flex flex-col' : 'flex min-h-0 flex-1 flex-col'}
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
              className={cn(
                'text-prose w-full resize-none bg-paper px-4 py-4 font-serif leading-6.75 outline-none',
                card ? 'min-h-36' : 'min-h-48 flex-1',
              )}
            />
            <AttachedFiles
              files={draft.attachments}
              fromOriginal={fromOriginal}
              onChange={(attachments) => edit({ attachments })}
            />
            <div
              data-tool-row
              className="flex h-9 shrink-0 items-center gap-1 border-t border-rule px-3"
            >
              <AttachPicker
                files={draft.attachments}
                recordId={recordId}
                recordName={recordName}
                onChange={(attachments) => edit({ attachments })}
              />
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
                    icon: <icon.template />,
                    opens: true,
                    onSelect: () => setTemplating(true),
                  },
                  {
                    label: 'Delete draft…',
                    icon: <icon.delete />,
                    opens: true,
                    destructive: true,
                    onSelect: () => void deleteDraft(),
                  },
                ]}
              />
            </div>
          </div>
          {error === null ? null : (
            <p role="alert" className="px-4 pb-3 text-ui text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
      <DialogFooter
        note={note}
        {...(card
          ? { className: 'mx-0 mt-0 mb-0 shrink-0' }
          : review === null
            ? {}
            : { className: 'mt-0' })}
      >
        {review === null ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={sending}
              onClick={() => void cancel()}
            >
              Cancel
            </Button>
            <Button
              type="button"
              shortcut="⌘↵"
              pending={reviewing}
              disabled={busy}
              onClick={primary}
            >
              Review
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={sending}
              onClick={() => setReview(null)}
            >
              Back to draft
            </Button>
            {reconnect !== null ? (
              <Button asChild>
                <a
                  data-reconnect
                  // Client state only: a sender is read after mount.
                  href={reconnectHref(
                    reconnect,
                    home,
                    draft.id,
                    window.location,
                  )}
                >
                  Reconnect Gmail
                </a>
              </Button>
            ) : sender !== null && sender._tag === 'unavailable' ? (
              <SendBlocked sender={sender} />
            ) : (
              <Button
                type="button"
                shortcut="⌘↵"
                pending={sending}
                // Off while a blank is open; the flagged copy says which.
                disabled={busy || sender === null || open > 0}
                onClick={primary}
              >
                {sending ? (
                  <>
                    <Twinkle tone="paper" />
                    Sending
                  </>
                ) : failure !== null ? (
                  'Retry'
                ) : (
                  sendLabel(messageCount(copies.length))
                )}
              </Button>
            )}
          </>
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
      {deleting.confirmDialog}
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
 * The files the draft carries: a glyph, the name and a mono size, `From
 * original` on a forward's own, each with its ×. Nothing while there are none.
 */
function AttachedFiles({
  files,
  fromOriginal,
  onChange,
}: {
  files: ReadonlyArray<DraftDocument>
  fromOriginal: ReadonlySet<string>
  onChange: (next: Array<DraftDocument>) => void
}) {
  if (files.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-4">
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
            <icon.close className="size-4" />
          </button>
        </span>
      ))}
    </div>
  )
}

/**
 * Attach, the tool row's first: one of the record's files, or an upload,
 * filed on that record when there is one.
 */
function AttachPicker({
  files,
  recordId,
  recordName,
  onChange,
}: {
  files: ReadonlyArray<DraftDocument>
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
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={uploading}
            className="focus-ring flex h-7 items-center gap-1.5 rounded-md px-2 text-label text-graphite hover:bg-bone hover:text-foreground"
          >
            {uploading ? (
              <>
                <Twinkle size={14} />
                Uploading
              </>
            ) : (
              <>
                <Attachment aria-hidden className="size-4" />
                Attach
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex flex-col gap-1 p-1">
          {offered.length === 0 || recordName === null ? null : (
            <span className="flex h-7 items-center px-2 label-caps text-graphite">
              {recordName}
            </span>
          )}
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
    </>
  )
}
