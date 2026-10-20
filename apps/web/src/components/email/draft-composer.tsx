import { Paperclip, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { KeyHint } from '#/components/page-header'
import { Button } from '#/components/ui/button'
import { DialogFooter } from '#/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Tabs } from '#/components/ui/tabs'
import { uploadDocument } from '#/lib/documents/upload'
import {
  recipientCount,
  saveInput,
  switchMode,
  useDraftAutosave,
} from '#/lib/email/compose'
import type { DraftState } from '#/lib/email/compose'
import {
  deleteEmailDraft,
  listRecordDocuments,
  saveEmailDraft,
} from '#/lib/server-fns'
import type { DraftDocument, ReplyOpening } from '#/lib/server-fns'
import { AddressRow, RecipientLine } from './recipient-line'

/**
 * The composer (D67; E3 inline under a message, E4 in its own window): the
 * address block, the subject, the body and the files, then the foot.
 * - Cc and Bcc open from the address block and are closed when empty.
 * - Autosaved after `AUTOSAVE_MS` of quiet; Cancel and closing keep the row.
 * - Trash deletes it. ⌘↵ anywhere in the composer is Send, the one printed key.
 * - Send saves the draft until the Gmail send lane exists to hand it to.
 */

type ReplyMode = keyof ReplyOpening['modes']

const MODE_TABS: ReadonlyArray<{ id: ReplyMode; label: string }> = [
  { id: 'reply', label: 'Reply' },
  { id: 'reply_all', label: 'Reply all' },
  { id: 'forward', label: 'Forward' },
]

/** `saved 09:16`, in the reader's clock. */
export function savedLine(iso: string | null): string | null {
  if (iso === null) return null
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `saved ${p(d.getHours())}:${p(d.getMinutes())}`
}

const plural = (n: number, noun: string) =>
  `${String(n)} ${noun}${n === 1 ? '' : 's'}`

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
  /** What sits over the address block: the folded message, for E3. */
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

  function edit(next: Partial<DraftState>) {
    setDraft((d) => ({ ...d, ...next }))
    setDirty(true)
  }

  function pickMode(mode: ReplyMode) {
    if (modes === null || draft.mode === 'new') return
    const from = modes[draft.mode]
    setDraft((d) => switchMode(d, from, modes[mode]))
    setDirty(true)
  }

  async function cancel() {
    await autosave.flush()
    onClose()
  }

  async function send() {
    setSending(true)
    autosave.cancel()
    await inflight.current
    await save(draft)
    setSending(false)
    toast('Saved to Drafts')
    onClose()
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

  return (
    <>
      <div
        className="-mx-5 flex min-h-0 flex-1 flex-col overflow-y-auto"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            if (!sending) void send()
          }
        }}
      >
        {above}
        {modes === null || draft.mode === 'new' ? null : (
          <Tabs
            items={MODE_TABS}
            value={draft.mode}
            onValueChange={pickMode}
            label="Reply mode"
            size="head"
            trail={
              saved === null ? undefined : (
                <span
                  data-saved
                  className="ml-auto pr-2 mono text-micro text-graphite"
                >
                  {saved}
                </span>
              )
            }
          />
        )}
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
        <Button type="button" variant="outline" onClick={() => void cancel()}>
          Cancel
        </Button>
        <Button
          type="button"
          pending={sending}
          disabled={sending}
          onClick={() => void send()}
        >
          {sending ? 'Saving…' : 'Send'}
          <KeyHint>⌘↵</KeyHint>
        </Button>
      </DialogFooter>
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
