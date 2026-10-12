import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { formatBytes } from '@spaces/core/documents'
import { DocumentPreview } from '#/components/document-preview'
import { LabelHead, LedgerRow } from '#/components/ledger-section'
import { DensityRamp } from '#/components/dither'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { getDocumentPreview, getEmail } from '#/lib/server-fns'
import type {
  EmailAttachment,
  EmailBody,
  EmailDetail,
  EmailParticipant,
} from '#/lib/server-fns'
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
 */
export function EmailDialog({
  id,
  onOpenChange,
}: {
  id: string | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={id !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[48rem]">
        {id === null ? null : (
          <EmailWindow key={id} id={id} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The window opened from the page's own URL: `?modal=email&id=` (D74).
 * Closing drops the two params and keeps the rest.
 */
export function EmailModal() {
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  return (
    <EmailDialog
      id={openModalId(search, 'email')}
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

function EmailWindow({ id, onClose }: { id: string; onClose: () => void }) {
  const [email, setEmail] = useState<EmailDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<Awaited<
    ReturnType<typeof getDocumentPreview>
  > | null>(null)

  useEffect(() => {
    let live = true
    getEmail({ data: { id } })
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
  }, [id])

  async function openAttachment(a: EmailAttachment) {
    const doc = await getDocumentPreview({ data: { id: a.documentId } })
    if (doc) setViewer(doc)
  }

  const foot = (
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
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
  return (
    <>
      <DialogHeader>
        <DialogTitle>{email.subject || 'Untitled'}</DialogTitle>
        <DialogDescription>{stamp(email.occurredAt)}</DialogDescription>
      </DialogHeader>

      <div className="-mx-5 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5">
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
                    <span className="min-w-0 flex-1 truncate text-body">
                      {a.name}
                    </span>
                    {a.sizeBytes === null ? null : (
                      <span className="shrink-0 mono text-micro text-graphite">
                        {formatBytes(a.sizeBytes)}
                      </span>
                    )}
                  </button>
                </LedgerRow>
              ))}
            </ol>
          </section>
        )}
      </div>

      {foot}

      <DocumentPreview
        doc={viewer}
        onOpenChange={(open) => {
          if (!open) setViewer(null)
        }}
      />
    </>
  )
}
