import { useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { Email, icon } from '#/components/icons'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { DocumentPreview } from '#/components/document-preview'
import { DraftComposer } from '#/components/email/draft-composer'
import type { FileActions, ReplyMode } from '#/components/email/message-card'
import { EmailThread } from '#/components/email/thread'
import { AttachmentSidebar } from '#/components/email/attachment-sidebar'
import { PaneHead } from '#/components/email/pane-head'
import { WidenDialog } from '#/components/email/who-can-read'
import { useKeepCopy } from '#/components/files/keep-copy'
import type { KeepCopy } from '#/components/files/keep-copy'
import { NewerVersionDialog } from '#/components/files/newer-version-dialog'
import { FilingPickers } from '#/components/files/viewer-sidebar'
import type { RecordDocument } from '#/components/files/types'
import { PickPopover } from '#/components/record/details-add'
import { ProviderMark } from '#/components/provider-mark'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
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
import {
  fileDocument,
  fileInteractionOnEntity,
  getDocumentPreview,
  getEmail,
  listRecordDocuments,
  openEmailReply,
  searchEntities,
  unlinkInteractionFromEntity,
} from '#/lib/server-fns'
import type {
  EmailAttachment,
  EmailDetail,
  EmailPrivacy,
  ReplyOpening,
} from '#/lib/server-fns'
import { draftStateOf, replyDraft } from '#/lib/email/compose'
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
 * The same thread as the Email page's right pane: the head carries the
 * `···` and Reply, and there is no Done. A reply grows as the last card,
 * its foot at the pane's foot.
 */
export function EmailPane({
  id,
  onClose,
}: {
  id: string
  /** The thread left the pane: unlinked, or the read failed past repair. */
  onClose: () => void
}) {
  return (
    <div data-email-pane className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EmailWindow
        key={id}
        id={id}
        recordId={null}
        frame="pane"
        onClose={onClose}
      />
    </div>
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
  frame = 'window',
  onClose,
}: {
  id: string
  recordId: string | null
  /** A dialog's head and foot, or a page pane's head with the acts in it. */
  frame?: 'window' | 'pane'
  onClose: () => void
}) {
  const pane = frame === 'pane'
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
    notSent: string | null
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

  const keepCopy = useKeepCopy()
  // The window holds the thread and the open file in state, so a kept copy
  // re-reads both: the card's `···` and the Source line stop offering it.
  const keeper: KeepCopy = {
    busy: keepCopy.busy,
    keep: async (documentId) => {
      const kept = await keepCopy.keep(documentId)
      if (kept) {
        setReads((n) => n + 1)
        if (viewer?.doc.id === documentId) await view(viewer.files, viewer.at)
      }
      return kept
    },
  }

  const actions: FileActions = {
    recordId,
    onOpen: (a, files) => void view(files, files.indexOf(a)),
    onFileOn: setFiling,
    onNewer: (a) => void newerVersion(a),
    keeper,
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
              draft: replyDraft(
                crypto.randomUUID(),
                opened.modes[mode],
                opened.signature,
              ),
              savedAt: null,
              notSent: null,
            }
          : {
              modes: opened.modes,
              draft: draftStateOf(opened.draft),
              savedAt: opened.draft.updatedAt,
              notSent: opened.draft.sendError,
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
  // The thread's `···` and Reply: the window's foot holds them, a pane's head.
  const acts =
    email === null ? null : (
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
    )
  const foot = (
    <DialogFooter className={EDGE} {...(note === null ? {} : { note })}>
      <Button variant="outline" onClick={onClose}>
        Done
      </Button>
      {acts}
    </DialogFooter>
  )

  if (email === null && pane)
    return (
      <>
        <PaneHead title="Email" />
        <div className="flex min-h-48 flex-1 items-center justify-center bg-bone px-4">
          {error === null ? (
            <Twinkle size={29} />
          ) : (
            <p className="text-ui text-destructive">{error}</p>
          )}
        </div>
      </>
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
  const viewing = viewer?.files.at(viewer.at)
  const extras = (
    <>
      <DocumentPreview
        doc={viewer?.doc ?? null}
        sidebar={
          viewer === null || viewing === undefined ? null : (
            <AttachmentSidebar
              attachment={viewing}
              doc={viewer.doc}
              subject={email.subject ?? ''}
              keeper={keeper}
            />
          )
        }
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
  const size =
    email.thread.messages < 2 ? null : plural(email.thread.messages, 'message')
  // A pane has no foot: who reads the body, or why a reply did not open,
  // stands before the thread's size in its head.
  const paneHead = (
    <PaneHead
      title={email.subject || 'Untitled'}
      context={
        note === null ? (
          size
        ) : (
          <>
            <span
              data-pane-note
              className={replyError === null ? undefined : 'text-destructive'}
            >
              {note}
            </span>
            {size === null ? null : ` · ${size}`}
          </>
        )
      }
    >
      {reply === null ? acts : null}
    </PaneHead>
  )
  const head = pane ? (
    paneHead
  ) : (
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
          notSent={reply.notSent}
          // A thread's URL does not open its reply: the consent comes back
          // to the draft's own window, over the record or the Email page.
          home={recordId === null ? 'email' : 'record'}
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
      {pane ? null : foot}
      {extras}
    </>
  )
}
