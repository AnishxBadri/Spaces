import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { formatBytes } from '@spaces/core/documents'
import { DocumentPreview } from '#/components/document-preview'
import { DraftComposer } from '#/components/email/draft-composer'
import { FileGlyph } from '#/components/files/file-glyph'
import { LabelHead, LedgerRow } from '#/components/ledger-section'
import { DensityRamp } from '#/components/dither'
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
import {
  getDocumentPreview,
  getEmail,
  listMembers,
  openEmailReply,
  setEmailAudience,
} from '#/lib/server-fns'
import type {
  EmailAttachment,
  EmailBody,
  EmailDetail,
  EmailParticipant,
  EmailPrivacy,
  ReplyOpening,
} from '#/lib/server-fns'
import { draftStateOf } from '#/lib/email/compose'
import type { DraftState } from '#/lib/email/compose'
import { fileType } from '#/lib/documents/files-tab'
import { openModalId } from '#/lib/modal-search'
import { stamp } from '#/lib/timeline/stamp'

/**
 * The email window (D67, E2): subject and date in the bone head, the
 * participants, the body, then the attachments. Cancel is the one close.
 * - The body is the server's sanitized document in an iframe sandboxed with
 *   no scripts and no forms; popups are allowed so a link opens a new tab.
 * - Same-origin lets the window size the frame to its content; with no
 *   scripts in the frame and a CSP refusing every load, it grants nothing.
 * - A body private to someone else is one line, never fetched. (D67)
 * - A body private by default carries its privacy row; its owner widens it
 *   from there, for `recordId` (the record it was opened from) or members.
 * - Reply is the foot's primary: the draft grows under the message (E3),
 *   which folds to one line, and the mode is a row of tabs.
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
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[48rem]">
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
 * The window opened from the page's own URL: `?modal=email&id=` (D74).
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

const LANE = 'w-10 shrink-0 field-label text-graphite'

function Who({ p }: { p: EmailParticipant }) {
  return p.name === null ? (
    <span className="mono text-micro text-foreground">{p.email}</span>
  ) : (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-ui">{p.name}</span>
      <span className="mono text-micro text-graphite">{p.email}</span>
    </span>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className={LANE}>{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-0.5">
        {children}
      </span>
    </div>
  )
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

function Body({ body }: { body: EmailBody }) {
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
        <p data-body-private className="px-3 py-2 text-ui text-graphite">
          Body private.
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

/** An attachment's mono end lane: `1.2 MB · via gmail`. */
export function attachmentLane(
  a: Pick<EmailAttachment, 'sizeBytes' | 'lane'>,
): string {
  return [
    formatBytes(a.sizeBytes) || null,
    a.lane === null ? null : `via ${a.lane}`,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/**
 * Who reads the body: `you`, the owner's name, granted members, or
 * `workspace` once the owner's override on a record it is on covers it.
 */
export function audienceLine(p: EmailPrivacy): string {
  if (p.workspace) return 'workspace'
  return [
    p.mine ? 'you' : p.owner.name,
    ...p.grantees.map((g) => (g.you ? 'you' : g.name)),
  ].join(', ')
}

/** `visible to: you · widen` — the widen control is the owner's alone. */
function PrivacyRow({
  privacy,
  onWiden,
}: {
  privacy: EmailPrivacy
  onWiden: () => void
}) {
  return (
    <p data-privacy className="mono text-micro text-graphite">
      visible to: {audienceLine(privacy)}
      {privacy.mine ? (
        <>
          {' · '}
          <button
            type="button"
            onClick={onWiden}
            className="focus-ring text-foreground hover:underline"
          >
            widen
          </button>
        </>
      ) : null}
    </p>
  )
}

type Member = { id: string; name: string }

/**
 * The widen window: the record it was opened from (the owner's override
 * there) and the members granted this one email. Ticked is open, unticked
 * is closed; Cancel is the one close.
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
  const [ticked, setTicked] = useState(
    () => new Set(privacy.grantees.map((g) => g.id)),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRecord(privacy.record?.on ?? false)
    setTicked(new Set(privacy.grantees.map((g) => g.id)))
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

  function toggle(id: string, on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function save() {
    setSaving(true)
    try {
      await setEmailAudience({
        data: {
          interactionId: emailId,
          userIds: [...ticked],
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
      <DialogContent className="flex max-h-[70vh] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Visible to</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          Who reads this email
        </DialogDescription>
        <div className="-mx-5 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5">
          {privacy.record === null ? null : (
            <section aria-label="Record" className="flex flex-col">
              <LabelHead label="Record" />
              <ol>
                <LedgerRow last>
                  <label className="flex min-w-0 flex-1 items-center gap-3">
                    <Checkbox
                      checked={record}
                      onCheckedChange={setRecord}
                      aria-label={privacy.record.name}
                    />
                    <span className="min-w-0 flex-1 truncate text-body">
                      {privacy.record.name}
                    </span>
                    <span className="shrink-0 mono text-micro text-graphite">
                      workspace
                    </span>
                  </label>
                </LedgerRow>
              </ol>
            </section>
          )}
          <section aria-label="Members" className="flex flex-col">
            <LabelHead label="Members" />
            {members === null ? (
              <DensityRamp width={120} />
            ) : (
              <ol>
                {members.map((m, i) => (
                  <LedgerRow key={m.id} last={i === members.length - 1}>
                    <label className="flex min-w-0 flex-1 items-center gap-3">
                      <Checkbox
                        checked={ticked.has(m.id)}
                        onCheckedChange={(on) => toggle(m.id, on)}
                        aria-label={m.name}
                      />
                      <span className="min-w-0 flex-1 truncate text-body">
                        {m.name}
                      </span>
                    </label>
                  </LedgerRow>
                ))}
              </ol>
            )}
          </section>
          {error === null ? null : (
            <p className="text-ui text-destructive">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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
  const [email, setEmail] = useState<EmailDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<Awaited<
    ReturnType<typeof getDocumentPreview>
  > | null>(null)
  const [widening, setWidening] = useState(false)
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

  async function openAttachment(a: EmailAttachment) {
    const doc = await getDocumentPreview({ data: { id: a.documentId } })
    if (doc) setViewer(doc)
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
          <DensityRamp width={160} />
        ) : (
          <p className="text-ui text-destructive">{error}</p>
        )}
        {foot}
      </>
    )

  const remote = remoteLine(email.body)
  const message = (
    <>
      <section aria-label="Participants" className="flex flex-col gap-1 px-3">
        {email.from === null ? null : (
          <Line label="from">
            <Who p={email.from} />
          </Line>
        )}
        {email.to.length === 0 ? null : (
          <Line label="to">
            {email.to.map((p) => (
              <Who key={p.email} p={p} />
            ))}
          </Line>
        )}
        {email.cc.length === 0 ? null : (
          <Line label="cc">
            {email.cc.map((p) => (
              <Who key={p.email} p={p} />
            ))}
          </Line>
        )}
        {email.via === null ? null : (
          <Line label="via">
            <span className="text-ui">{email.via}</span>
          </Line>
        )}
        {email.privacy === null ? null : (
          <PrivacyRow
            privacy={email.privacy}
            onWiden={() => setWidening(true)}
          />
        )}
      </section>

      <section aria-label="Message" className="flex flex-col gap-3">
        <LabelHead label="Message">
          {remote === null ? null : (
            <span
              data-remote-images
              className="shrink-0 mono text-micro text-graphite"
            >
              {remote}
            </span>
          )}
        </LabelHead>
        <Body body={email.body} />
      </section>

      {email.attachments.length === 0 ? null : (
        <section aria-label="Attachments" className="flex flex-col">
          <LabelHead label="Attachments" />
          <ol>
            {email.attachments.map((a, i) => (
              <LedgerRow
                key={a.documentId}
                last={i === email.attachments.length - 1}
              >
                <button
                  type="button"
                  onClick={() => void openAttachment(a)}
                  className="focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left hover:bg-bone"
                >
                  <FileGlyph
                    type={fileType({
                      filename: a.filename,
                      mime: a.mime,
                      externalUrl: null,
                    })}
                  />
                  <span className="min-w-0 flex-1 truncate text-body">
                    {a.name}
                  </span>
                  <span
                    data-attachment-lane
                    className="shrink-0 mono text-micro text-graphite"
                  >
                    {attachmentLane(a)}
                  </span>
                </button>
              </LedgerRow>
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
      <DialogDescription>{stamp(email.occurredAt)}</DialogDescription>
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
          onClose={() => setReply(null)}
          above={
            unfolded ? (
              <div className="flex flex-col gap-6 border-b border-rule px-5 py-4">
                {message}
              </div>
            ) : (
              <FoldedMessage email={email} onShow={() => setUnfolded(true)} />
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

/** The message folded to one line over a reply: sender, a preview, `show ›`. */
function FoldedMessage({
  email,
  onShow,
}: {
  email: EmailDetail
  onShow: () => void
}) {
  const files = email.attachments.length
  const preview =
    email.body.kind === 'text' ? email.body.text.replace(/\s+/g, ' ') : ''
  return (
    <button
      type="button"
      data-folded-message
      onClick={onShow}
      className="focus-ring-inset flex min-h-10 w-full shrink-0 items-center gap-3 border-b border-rule px-5 text-left hover:bg-bone"
    >
      <span className="shrink-0 text-ui">
        {email.from?.name ?? email.from?.email ?? 'Unknown'}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui text-graphite">
        {preview}
      </span>
      <span className="shrink-0 mono text-micro text-graphite">
        {files > 0 ? `${String(files)} file${files === 1 ? '' : 's'} · ` : ''}
        show ›
      </span>
    </button>
  )
}
