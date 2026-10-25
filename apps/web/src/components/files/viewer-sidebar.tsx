import { Link, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Select } from '../ui/select'
import { FollowedRevisions } from './revision-ledger'
import type { FilingEdge, RecordDocument } from './types'
import { DOCUMENT_KIND_LABELS } from '@spaces/core/documents'
import {
  fileDocument,
  getDocumentDetails,
  listSpaces,
  reExtractDocument,
  searchEntities,
  setDocumentKind,
  unfileDocument,
} from '#/lib/server-fns'
import { KIND_ORDER } from '#/lib/documents/files-tab'
import { recordPath } from '#/lib/record-path'

/**
 * The viewer's sidebar on a Files tab: KIND, FILED ON with File on…,
 * VERSIONS (REVISIONS for a followed file), TEXT, MENTIONED IN and SOURCE. Filing is a re-file: every
 * edge, not just this record's, because one file sits in several places.
 */

type Details = Awaited<ReturnType<typeof getDocumentDetails>>

function Section({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-rule px-4 py-3">
      <h3 className="label-caps text-graphite">
        {label}
        {count === undefined ? null : ` · ${String(count)}`}
      </h3>
      {children}
    </section>
  )
}

/** A row in a sidebar section: the value, and a mono mark at its end. */
function Line({ children, mark }: { children: ReactNode; mark?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="min-w-0 truncate text-ui">{children}</span>
      {mark === undefined ? null : (
        <span className="shrink-0 mono text-micro text-graphite">{mark}</span>
      )}
    </div>
  )
}

/** The sidebar's facts the Files-tab row does not carry, fetched per file. */
export function useDocumentDetails(id: string | null): Details {
  const [details, setDetails] = useState<Details>(null)
  useEffect(() => {
    setDetails(null)
    if (id === null) return
    let stale = false
    getDocumentDetails({ data: { id } }).then(
      (d) => {
        if (!stale) setDetails(d)
      },
      () => undefined,
    )
    return () => {
      stale = true
    }
  }, [id])
  return details
}

export function FileViewerSidebar({
  doc,
  recordId,
}: {
  doc: RecordDocument
  /** The record whose Files tab opened it: where Unfollow refreshes. */
  recordId: string
}) {
  const router = useRouter()
  const details = useDocumentDetails(doc.id)
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await action()
        await router.invalidate()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not file')
      } finally {
        setBusy(false)
      }
    },
    [router],
  )

  return (
    <>
      <Section label="Kind">
        <Select
          aria-label={`Kind of ${doc.filename}`}
          value={doc.kind}
          disabled={busy}
          onChange={(kind) =>
            void run(() =>
              setDocumentKind({ data: { documentId: doc.id, kind } }),
            )
          }
          items={KIND_ORDER.map((k) => ({
            value: k,
            label: DOCUMENT_KIND_LABELS[k],
          }))}
          width="trigger"
        />
      </Section>

      <Section label="Filed on" count={doc.filedIn.length}>
        {doc.filedIn.map((edge) => (
          <FiledOnLine
            key={`${edge.kind}-${edge.id}`}
            edge={edge}
            busy={busy}
            onUnfile={() =>
              void run(() =>
                unfileDocument({
                  data: {
                    documentId: doc.id,
                    target: { kind: edge.kind, entityId: edge.id },
                  },
                }),
              )
            }
          />
        ))}
        <FileOn
          filedIds={doc.filedIn.map((e) => e.id)}
          disabled={busy}
          onPick={(target) =>
            void run(() =>
              fileDocument({ data: { documentId: doc.id, target } }),
            )
          }
        />
      </Section>

      {doc.follow === null ? (
        <Section label="Versions" count={1}>
          <Line
            mark={[doc.createdAt.slice(5, 10), doc.uploadedByName]
              .filter((part) => part !== null)
              .join(' · ')}
          >
            v1 · this one
          </Line>
        </Section>
      ) : (
        <FollowedRevisions doc={doc} recordId={recordId} />
      )}

      <Section label="Text">
        <p className="text-ui">{textLine(doc, details)}</p>
      </Section>

      {details === null || details.mentionedIn.length === 0 ? null : (
        <Section label="Mentioned in" count={details.mentionedIn.length}>
          {details.mentionedIn.map((m) => (
            <Line key={m.id} mark={`note · ${m.at.slice(5, 10)}`}>
              <Link
                to="/notes/$noteId"
                params={{ noteId: m.id }}
                className="focus-ring hover:underline"
              >
                {m.name}
              </Link>
            </Line>
          ))}
        </Section>
      )}

      <Section label="Source">
        <p className="mono text-micro">
          {[
            doc.sourceCapability === null
              ? doc.uploadedByName === null
                ? 'uploaded'
                : `uploaded by ${doc.uploadedByName}`
              : `via ${doc.sourceCapability}`,
            doc.createdAt.slice(0, 10),
          ].join(' · ')}
        </p>
        {doc.sourcePath === null ? null : (
          <p className="truncate mono text-micro text-graphite">
            from {doc.sourcePath}
          </p>
        )}
        {doc.blobSha === null ? null : (
          <p className="mono text-micro text-graphite">
            sha {doc.blobSha.slice(0, 4)}…{doc.blobSha.slice(-4)} · stays on
            this server
          </p>
        )}
      </Section>
    </>
  )
}

/** `14 pages read, 3,812 words.`, or what the read is doing instead. */
export function textLine(
  doc: Pick<
    RecordDocument,
    'extractionStatus' | 'extractionError' | 'url' | 'blobSha'
  >,
  details: Pick<NonNullable<Details>, 'words' | 'pages'> | null,
): string {
  if (doc.extractionStatus === 'pending')
    return doc.url !== null && doc.blobSha === null
      ? 'Fetching the page.'
      : 'Reading the text.'
  if (doc.extractionStatus === 'failed')
    return `The read failed: ${doc.extractionError ?? 'no reason given'}.`
  if (doc.extractionStatus === 'unsupported') return 'No text in this file.'
  if (details === null || details.words === null) return 'Text read.'
  const words = `${details.words.toLocaleString('en-US')} word${details.words === 1 ? '' : 's'}`
  return details.pages === null
    ? `${words} read.`
    : `${String(details.pages)} page${details.pages === 1 ? '' : 's'} read, ${words}.`
}

function FiledOnLine({
  edge,
  busy,
  onUnfile,
}: {
  edge: FilingEdge
  busy: boolean
  onUnfile: () => void
}) {
  // A custom record routes through its object's slug; a kind with no page
  // reads as plain text rather than a broken link.
  const href =
    edge.kind === 'space'
      ? `/spaces/${edge.id}`
      : recordPath({
          kind: edge.entityKind,
          id: edge.id,
          objectSlug: edge.objectSlug,
        })
  return (
    <div className="group flex min-h-7 items-center justify-between gap-3">
      <span className="min-w-0 truncate text-ui">
        {href ? (
          <Link to={href} className="focus-ring hover:underline">
            {edge.name}
          </Link>
        ) : (
          edge.name
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2 mono text-micro text-graphite">
        {edge.kind === 'space' ? 'space' : edge.entityKind}
        <button
          type="button"
          aria-label={`Unfile from ${edge.name}`}
          disabled={busy}
          onClick={onUnfile}
          className="focus-ring opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          ×
        </button>
      </span>
    </div>
  )
}

type FilingTarget = { kind: 'record' | 'space'; entityId: string }

/** `+ File on…`: a record search and the space tree, in one popover. */
function FileOn({
  filedIds,
  disabled,
  onPick,
}: {
  filedIds: Array<string>
  disabled: boolean
  onPick: (target: FilingTarget) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="focus-ring flex h-7 items-center gap-1.5 self-start text-ui text-graphite hover:text-foreground"
        >
          <span aria-hidden className="text-primary">
            +
          </span>
          File on…
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <RecordPicker
          disabled={disabled}
          filedIds={filedIds}
          onPick={(entityId) => {
            onPick({ kind: 'record', entityId })
            setOpen(false)
          }}
        />
        <SpacePicker
          open={open}
          disabled={disabled}
          filedIds={filedIds}
          onPick={(entityId) => {
            onPick({ kind: 'space', entityId })
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * A debounced record search. The kinds are explicit: a document filed
 * against a document is a mention, not a filing; `fileDocumentProgram`
 * refuses the same targets.
 */
function RecordPicker({
  filedIds,
  disabled,
  onPick,
}: {
  filedIds: Array<string>
  disabled: boolean
  onPick: (entityId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<
    Awaited<ReturnType<typeof searchEntities>>
  >([])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        const rows = await searchEntities({
          data: { q: query, kinds: ['company', 'person', 'deal', 'custom'] },
        })
        if (alive) setResults(rows)
      })()
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  const offered = results.filter((r) => !filedIds.includes(r.id))

  return (
    <div>
      <Input
        value={query}
        disabled={disabled}
        placeholder="File on a record…"
        onChange={(e) => setQuery(e.target.value)}
        className="h-7 text-label"
      />
      {offered.length > 0 ? (
        <ul className="mt-1 flex flex-col">
          {offered.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onPick(r.id)
                  setQuery('')
                }}
                className="focus-ring flex h-7 w-full items-center px-2 text-left text-ui hover:bg-bone"
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {query.trim() && offered.length === 0 ? (
        <p className="mt-1 px-2 text-label text-graphite">No record matches.</p>
      ) : null}
    </div>
  )
}

/** The space tree, fetched when the popover opens rather than per row. */
function SpacePicker({
  open,
  filedIds,
  disabled,
  onPick,
}: {
  open: boolean
  filedIds: Array<string>
  disabled: boolean
  onPick: (entityId: string) => void
}) {
  const [spaces, setSpaces] = useState<Awaited<ReturnType<typeof listSpaces>>>(
    [],
  )

  useEffect(() => {
    if (!open) return
    // A cell: the flag is read after an `await`.
    const live = { current: true }
    void (async () => {
      try {
        const rows = await listSpaces()
        if (live.current) setSpaces(rows)
      } catch {
        if (live.current) setSpaces([])
      }
    })()
    return () => {
      live.current = false
    }
  }, [open])

  const unfiled = spaces.filter((s) => !filedIds.includes(s.id))
  if (unfiled.length === 0) return null

  return (
    <div className="mt-1.5">
      <Select
        aria-label="File this document into a space"
        value=""
        disabled={disabled}
        onChange={onPick}
        items={unfiled.map((s) => ({
          value: s.id,
          label: s.name,
          depth: s.depth,
        }))}
        width="content"
        placeholder="+ File into a space…"
        searchPlaceholder="Search spaces…"
        emptyLabel="No space matches."
        className="h-7 w-full rounded-none border-dashed bg-transparent px-2 text-label text-graphite hover:text-foreground"
      />
    </div>
  )
}

/** The viewer's foot on a Files tab: Delete file… and Re-read text. */
export function FileViewerFoot({
  doc,
  onDelete,
}: {
  doc: RecordDocument
  onDelete: () => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function reRead() {
    setBusy(true)
    try {
      const { queued } = await reExtractDocument({
        data: { documentId: doc.id },
      })
      // Pending either way and re-queueable; a down worker is said, not hidden.
      if (!queued) toast.message('Queued when the worker is back')
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not re-read')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onDelete}
        className="focus-ring mr-auto text-ui text-destructive hover:underline"
      >
        Delete file…
      </button>
      <Button variant="ghost" disabled={busy} onClick={() => void reRead()}>
        Re-read text
      </Button>
    </>
  )
}
