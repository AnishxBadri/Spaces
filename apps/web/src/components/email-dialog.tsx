import { useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { Email, icon } from '#/components/icons'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { DocumentPreview } from '#/components/document-preview'
import { DraftComposer } from '#/components/email/draft-composer'
import type { FileActions, ReplyMode } from '#/components/email/message-card'
import { EmailThread } from '#/components/email/thread'
import { NewerVersionDialog } from '#/components/files/newer-version-dialog'
import { FilingPickers } from '#/components/files/viewer-sidebar'
import type { RecordDocument } from '#/components/files/types'
import { LedgerRow } from '#/components/ledger-section'
import { PickPopover } from '#/components/record/details-add'
import { ProviderMark } from '#/components/provider-mark'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { MENU_RULE, MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import { Select } from '#/components/ui/select'
import {
  fileDocument,
  fileInteractionOnEntity,
  getDocumentPreview,
  getEmail,
  listMembers,
  listRecordDocuments,
  openEmailReply,
  searchEntities,
  setEmailAudience,
  unlinkInteractionFromEntity,
} from '#/lib/server-fns'
import type {
  EmailAttachment,
  EmailDetail,
  EmailPrivacy,
  ReplyOpening,
} from '#/lib/server-fns'
import { draftStateOf } from '#/lib/email/compose'
import type { DraftState } from '#/lib/email/compose'
import { openModalId } from '#/lib/modal-search'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

/**
 * The email window: the email glyph, the subject and the thread's size in
 * the bone head; the thread as message cards on bone (`EmailThread`); a
 * foot of Done, the thread's `···` and Reply. Done is the one close.
 * - A body private to someone else is a bone panel, never fetched.
 * - The foot's note says who reads the body only when that is not the
 *   default (`privacyNote`); its owner widens it from `Who can read this…`,
 *   for `recordId` (the record it was opened from) or members.
 * - Reply grows the draft as the last card, in ink, every message folded
 *   above it; the foot turns to the composer's Cancel and Send. Each open
 *   message's own `···` replies to, or forwards, that message.
 * - A file opens the viewer as a second window, stepping through the files
 *   of its message.
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
      <DialogContent size="l" flush className="h-[85vh]">
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

const plural = (n: number, noun: string) =>
  `${String(n)} ${noun}${n === 1 ? '' : 's'}`

/**
 * The foot's note on who reads the body, only when that is not the
 * default: your own private mail says nothing, mail its owner opened up
 * says so — `Shared with the workspace`, `Shared with Maya` to its owner,
 * `Shared by Priya Raman` to the members it reaches. `Who can read this…`
 * holds the full state.
 */
export function privacyNote(p: EmailPrivacy | null): string | null {
  if (p === null) return null
  if (p.mine) {
    if (p.workspace) return 'Shared with the workspace'
    if (p.grantees.length === 0) return null
    return `Shared with ${p.grantees.map((g) => g.name).join(', ')}`
  }
  return p.workspace || p.grantees.some((g) => g.you)
    ? `Shared by ${p.owner.name}`
    : null
}

/** The message in this window's own address, for Copy link. */
function emailLink(id: string): string {
  const url = new URL(window.location.href)
  url.searchParams.set('modal', 'email')
  url.searchParams.set('id', id)
  return url.toString()
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
        <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
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
                  <icon.close className="size-4" />
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

/** The head and foot run to the flush sheet's edges, the thread between. */
const EDGE = 'mx-0 mt-0 mb-0 shrink-0'

/** The bone ground the message cards stand on, 8px apart. */
const GROUND = 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-bone p-3'

/** The viewer over the thread: the files of one message, and which is open. */
type Viewing = {
  files: ReadonlyArray<EmailAttachment>
  at: number
  doc: NonNullable<Awaited<ReturnType<typeof getDocumentPreview>>>
}

function EmailWindow({
  id,
  recordId,
  onClose,
}: {
  id: string
  recordId: string | null
  onClose: () => void
}) {
  const { today } = useClock()
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [email, setEmail] = useState<EmailDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<Viewing | null>(null)
  const [widening, setWidening] = useState(false)
  const [filing, setFiling] = useState<EmailAttachment | null>(null)
  const [filingDeal, setFilingDeal] = useState(false)
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

  const searchDeals = useCallback(
    async (q: string) => {
      const rows = await searchEntities({ data: { q, kinds: ['deal'] } })
      return rows.filter((r) => r.id !== recordId)
    },
    [recordId],
  )

  async function view(files: ReadonlyArray<EmailAttachment>, at: number) {
    const a = files.at(at)
    if (a === undefined) return
    const doc = await getDocumentPreview({ data: { id: a.documentId } })
    if (doc) setViewer({ files, at, doc })
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

  const actions: FileActions = {
    recordId,
    onOpen: (a, files) => void view(files, files.indexOf(a)),
    onFileOn: setFiling,
    onNewer: (a) => void newerVersion(a),
  }

  /**
   * Reply, Reply all or Forward from one message; a draft held on that
   * message reopens as it was.
   */
  async function startDraft(parentId: string, mode: ReplyMode) {
    setReplyError(null)
    try {
      const opened = await openEmailReply({ data: { parentId } })
      setReply(
        opened.draft === null
          ? {
              modes: opened.modes,
              draft: { ...opened.modes[mode], id: crypto.randomUUID() },
              savedAt: null,
            }
          : {
              modes: opened.modes,
              draft: draftStateOf(opened.draft),
              savedAt: opened.draft.updatedAt,
            },
      )
    } catch (err) {
      setReplyError(
        err instanceof Error
          ? err.message
          : mode === 'forward'
            ? 'Could not forward'
            : 'Could not reply',
      )
    }
  }

  async function unlink(from: { id: string; name: string }) {
    const ok = await confirm({
      title: `Unlink from ${from.name}?`,
      body: `${email?.subject || 'This email'} leaves ${from.name}. It stays on every other record it is filed on.`,
      action: 'Unlink',
    })
    if (!ok) return
    try {
      await unlinkInteractionFromEntity({
        data: { interactionId: id, entityId: from.id },
      })
      onClose()
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not unlink')
    }
  }

  /** The thread's own acts; replying to one message is that card's `···`. */
  const menu: Array<MoreMenuEntry> =
    email === null
      ? []
      : [
          ...(email.gmailUrl === null
            ? []
            : [
                {
                  label: 'Open in Gmail',
                  icon: <ProviderMark brand="gmail" />,
                  href: email.gmailUrl,
                },
              ]),
          {
            label: 'Copy link',
            icon: <icon.copyLink />,
            copy: () => emailLink(email.id),
          },
          {
            label: 'File on a deal…',
            icon: <icon.fileOn />,
            opens: true,
            onSelect: () => setFilingDeal(true),
          },
          ...(email.privacy?.mine
            ? [
                {
                  label: 'Who can read this…',
                  icon: <icon.access />,
                  opens: true,
                  onSelect: () => setWidening(true),
                },
              ]
            : []),
          MENU_RULE,
          ...(email.record?.linked
            ? [
                {
                  label: `Unlink from ${email.record.name}…`,
                  icon: <icon.unlink />,
                  destructive: true,
                  opens: true,
                  onSelect: () => {
                    const from = email.record
                    if (from !== null) void unlink(from)
                  },
                },
              ]
            : []),
        ]

  const note =
    replyError ?? (email === null ? null : privacyNote(email.privacy))
  const foot = (
    <DialogFooter className={EDGE} {...(note === null ? {} : { note })}>
      <Button variant="outline" onClick={onClose}>
        Done
      </Button>
      {email === null ? null : (
        <>
          <MoreMenu
            variant="head"
            label={email.subject || 'email'}
            forceMenu
            items={menu}
          />
          <PickPopover
            open={filingDeal}
            onOpenChange={setFilingDeal}
            trigger={<span aria-hidden className="size-0" />}
            placeholder="File on a deal…"
            search={searchDeals}
            onPick={async (deal) => {
              const { filed } = await fileInteractionOnEntity({
                data: { interactionId: id, entityId: deal.id },
              })
              toast(filed ? `Filed on ${deal.name}` : `Already on ${deal.name}`)
              void router.invalidate()
            }}
          />
          <Button onClick={() => void startDraft(email.id, 'reply')}>
            Reply
          </Button>
        </>
      )}
    </DialogFooter>
  )

  if (email === null)
    return (
      <>
        <DialogHeader className={cn(EDGE, 'items-center')}>
          <Email aria-hidden className="size-5 text-graphite" />
          <DialogTitle>Email</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          The email is being read
        </DialogDescription>
        <div className="flex min-h-48 flex-1 items-center justify-center bg-bone px-4">
          {error === null ? (
            <Twinkle size={29} />
          ) : (
            <p className="text-ui text-destructive">{error}</p>
          )}
        </div>
        {foot}
      </>
    )

  const thread = (
    <EmailThread
      // Starting a draft folds every card; ending it opens the newest again.
      key={reply === null ? 'read' : 'draft'}
      email={email}
      recordId={recordId}
      today={today}
      drafting={reply !== null}
      actions={actions}
      onDraft={(messageId, mode) => void startDraft(messageId, mode)}
    />
  )
  const extras = (
    <>
      <DocumentPreview
        doc={viewer?.doc ?? null}
        onOpenChange={(open) => {
          if (!open) setViewer(null)
        }}
        steps={
          viewer === null
            ? null
            : {
                at: viewer.at,
                of: viewer.files.length,
                onStep: (to) => void view(viewer.files, to),
              }
        }
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
      {confirmDialog}
    </>
  )
  const head = (
    <DialogHeader className={cn(EDGE, 'flex-nowrap items-center')}>
      <Email
        data-window-mark
        aria-hidden
        className="size-5 shrink-0 text-graphite"
      />
      <DialogTitle className="min-w-0 truncate">
        {email.subject || 'Untitled'}
      </DialogTitle>
      <DialogDescription
        className={cn(
          'ml-auto shrink-0',
          email.thread.messages < 2 && 'sr-only',
        )}
      >
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
          card
          initial={reply.draft}
          savedAt={reply.savedAt}
          modes={reply.modes}
          recordId={recordId}
          recordName={email.record?.name ?? null}
          onClose={() => setReply(null)}
          above={thread}
        />
        {extras}
      </>
    )

  return (
    <>
      {head}
      <div data-thread className={GROUND}>
        {thread}
      </div>
      {foot}
      {extras}
    </>
  )
}
