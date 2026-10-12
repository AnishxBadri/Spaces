import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { LabelHead } from './ledger-section'
import { DocumentPreview } from './document-preview'
import { AddRow, LinkFetchRow, useLinkFetches } from './record-files-link'
import { StoragePicker, usePickerReadiness } from './storage-picker'
import { useSummarizer } from './summarize'
import { useKeyTermsExtractor } from './key-terms'
import { useVisionReader } from './vision'
import { FileRow, PendingRow, useRemoveFile } from './files/file-row'
import type { PendingUpload } from './files/file-row'
import { FolderBand } from './files/folder-band'
import type { BoundFolder } from './files/folder-band'
import { LinkFolderDialog } from './files/link-folder-dialog'
import { FileViewerFoot, FileViewerSidebar } from './files/viewer-sidebar'
import type { FileAction, RecordDocument } from './files/types'
import {
  DOCUMENT_KIND_LABELS,
  MAX_UPLOAD_BYTES,
  formatBytes,
  guessDocumentKind,
} from '@spaces/core/documents'
import {
  clipUrl,
  getEntitySensitivity,
  isLaneRouted,
  readDeck,
  readDeckAndSummarize,
  readDeckStatus,
} from '#/lib/server-fns'
import { uploadDocument } from '#/lib/documents/upload'
import { droppedUrl } from '#/lib/documents/uri-list'
import { storageLinkProvider } from '#/lib/documents/storage-link'
import { offersReadDeck } from '#/lib/documents/read-deck-gate'
import { KIND_ORDER } from '#/lib/documents/files-tab'

/**
 * A record's Files tab (D66, amended): one add row, our files grouped by
 * kind, a bound Drive folder as its own band, every row ending on a state
 * word. We make no folders — kind, filing and spaces do that work.
 * - The whole tab is the drop target; a drag washes it pine.
 * - Upload never streams through a server function: the browser hashes the
 *   file, PUTs it at storage, then files the row. Extraction runs on the
 *   worker after, so a fresh row reads `reading text.` for a moment.
 */

type Documents = Array<RecordDocument>

type DeckStatus = Awaited<ReturnType<typeof readDeckStatus>>[string]

/** What a row needs to offer Read deck; null when the row gets none. */
type DeckReader = {
  reading: boolean
  onRead: () => void
  onReadAndSummarize: (() => void) | null
}

export function RecordFiles({
  entityId,
  recordName,
  documents,
  folders = [],
}: {
  entityId: string
  /** The record's name: `Drop 3 files on Flent`, the Remove confirm. */
  recordName: string
  documents: Documents
  /** Drive folders bound to this record; none until bindings exist. */
  folders?: ReadonlyArray<BoundFolder>
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState<number | null>(null)
  const [pending, setPending] = useState<Array<PendingUpload>>([])
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [linkingFolder, setLinkingFolder] = useState<string | null>(null)
  const links = useLinkFetches(entityId)
  const [readiness, setReadiness] = usePickerReadiness()
  const { remove, removeDialog } = useRemoveFile(entityId, recordName)

  useExtractionPolling(documents, router)
  const deckReaderFor = useDeckReader(entityId, documents)
  // Summarize: any document whose text is extracted.
  const summarizerFor = useSummarizer(
    entityId,
    documents.filter((d) => d.extractionStatus === 'done').map((d) => d.id),
  )
  // Extract key terms: a legal or diligence document on a deal.
  const keyTermsFor = useKeyTermsExtractor(entityId, documents)
  // Read with vision: a stored PDF with no text layer.
  const visionFor = useVisionReader(entityId, documents)

  /** The `···` entries a row's lanes can run, in the order the strip had them. */
  function actionsFor(doc: RecordDocument): Array<FileAction> {
    const out: Array<FileAction> = []
    const reader = deckReaderFor(doc)
    if (reader !== null) {
      out.push({
        label: 'Read deck',
        busyLabel: 'Reading deck…',
        busy: reader.reading,
        run: reader.onRead,
      })
      if (reader.onReadAndSummarize !== null)
        out.push({
          label: 'Read deck and summarize',
          busyLabel: 'Reading deck…',
          busy: reader.reading,
          run: reader.onReadAndSummarize,
        })
    }
    const summarizer =
      doc.extractionStatus === 'done' ? summarizerFor(doc.id) : null
    if (summarizer !== null)
      out.push({
        label: 'Summarize',
        busyLabel: 'Summarizing…',
        busy: summarizer.summarizing,
        run: summarizer.onSummarize,
      })
    const keyTerms = keyTermsFor(doc)
    if (keyTerms !== null)
      out.push({
        label: 'Extract key terms',
        busyLabel: 'Extracting…',
        busy: keyTerms.extracting,
        run: keyTerms.onExtract,
      })
    const vision = visionFor(doc)
    if (vision !== null)
      out.push({
        label: 'Read with vision',
        busyLabel: 'Reading…',
        busy: vision.reading,
        run: vision.onRead,
      })
    return out
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Math.random()}`
      const controller = new AbortController()
      const patch = (next: Partial<PendingUpload>) =>
        setPending((all) =>
          all.map((p) => (p.key === key ? { ...p, ...next } : p)),
        )
      setPending((all) => [
        ...all,
        {
          key,
          name: file.name,
          kind: guessDocumentKind(file.name),
          sizeBytes: file.size,
          phase: 'hashing',
          progress: 0,
          error: null,
          cancel: () => controller.abort(),
        },
      ])
      try {
        await uploadDocument({
          file,
          // A drop on a record's tab files on this record and nowhere else.
          fileAgainst: [{ kind: 'record', entityId }],
          onPhase: (phase) => patch({ phase }),
          onProgress: (progress) => patch({ progress }),
          signal: controller.signal,
        })
        setPending((all) => all.filter((p) => p.key !== key))
        void router.invalidate()
      } catch (err) {
        if (controller.signal.aborted) {
          setPending((all) => all.filter((p) => p.key !== key))
          continue
        }
        patch({
          error: err instanceof Error ? err.message : 'Upload failed',
        })
      }
    }
  }

  /**
   * A link dropped or pasted: a Drive link is fetched by the worker as the
   * file it names; any other is saved as a page, fetched on the worker.
   */
  async function handleLink(url: string) {
    if (storageLinkProvider(url) !== null) {
      await links.attach(url)
      return
    }
    try {
      await clipUrl({
        data: { url, fileAgainst: [{ kind: 'record', entityId }] },
      })
      toast.success('Link saved · fetching the page')
      void router.invalidate()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save this link',
      )
    }
  }

  const inFolders = new Set(
    folders.flatMap((f) => f.documents.map((d) => d.id)),
  )
  const ours = documents.filter((d) => !inFolders.has(d.id))
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    uploads: pending.filter((p) => p.kind === kind),
    rows: ours.filter((d) => d.kind === kind),
  })).filter((g) => g.uploads.length + g.rows.length > 0)
  const empty =
    documents.length === 0 &&
    pending.length === 0 &&
    links.fetches.length === 0 &&
    folders.length === 0
  const totalBytes = documents.reduce((n, d) => n + (d.sizeBytes ?? 0), 0)
  // The live row, so the viewer follows a kind change or a re-read.
  const viewing = documents.find((d) => d.id === viewingId) ?? null

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        setDragging(
          [...e.dataTransfer.items].filter((i) => i.kind === 'file').length,
        )
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragging(null)
        // Read synchronously: `getData` answers the empty string once the
        // event has been dispatched, so a link read after an await is lost.
        const link = droppedUrl(e.dataTransfer)
        if (link !== null) {
          void handleLink(link)
          return
        }
        void handleFiles(e.dataTransfer.files)
      }}
      className={
        dragging === null
          ? 'relative flex flex-col'
          : 'relative flex min-h-72 flex-col'
      }
    >
      <AddRow
        onLink={(url) => void handleLink(url)}
        meta={
          documents.length === 0
            ? null
            : `${String(documents.length)} · ${formatBytes(totalBytes)}`
        }
      >
        <StoragePicker
          readiness={readiness}
          setReadiness={setReadiness}
          onPicked={(files) => void links.attachPicked(files)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => inputRef.current?.click()}
        >
          Upload
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More ways to add files"
            className="focus-ring flex size-[1.625rem] shrink-0 items-center justify-center rounded-md border border-hairline bg-paper mono text-ui hover:bg-bone data-[state=open]:bg-hairline data-[state=open]:text-paper"
          >
            <span aria-hidden>···</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {/* Folder binding arrives with storage bindings. */}
            <DropdownMenuItem disabled>Link a Drive folder…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </AddRow>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          void handleFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {links.fetches.length === 0 ? null : (
        <section>
          <LabelHead label={`Just added · ${String(links.fetches.length)}`} />
          <ul>
            {links.fetches.map((f) => (
              <LinkFetchRow
                key={f.key}
                fetch={f}
                onDismiss={() => links.dismiss(f.key)}
                onLinkFolder={setLinkingFolder}
              />
            ))}
          </ul>
        </section>
      )}

      {groups.map((g) => (
        <section key={g.kind}>
          <LabelHead
            label={`${DOCUMENT_KIND_LABELS[g.kind]} · ${String(g.uploads.length + g.rows.length)}`}
          />
          <ul>
            {g.uploads.map((p) => (
              <PendingRow
                key={p.key}
                pending={p}
                onDismiss={() =>
                  setPending((all) => all.filter((x) => x.key !== p.key))
                }
              />
            ))}
            {g.rows.map((doc) => (
              <FileRow
                key={doc.id}
                doc={doc}
                recordId={entityId}
                recordName={recordName}
                actions={actionsFor(doc)}
                older={g.rows.filter(
                  (d) =>
                    d.id !== doc.id &&
                    d.replacedBy?.id !== doc.id &&
                    doc.replacedBy?.id !== d.id,
                )}
                onView={() => setViewingId(doc.id)}
              />
            ))}
          </ul>
        </section>
      ))}

      {empty ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="focus-ring-inset m-3 flex h-ledger-row items-center justify-center border border-dashed border-rule text-ui text-graphite hover:bg-bone"
        >
          No files.
        </button>
      ) : null}

      {folders.map((f) => (
        <FolderBand
          key={f.id}
          folder={f}
          recordId={entityId}
          recordName={recordName}
          onView={(doc) => setViewingId(doc.id)}
        />
      ))}

      {dragging === null ? null : (
        <DropWash count={dragging} recordName={recordName} />
      )}

      <DocumentPreview
        doc={viewing}
        onOpenChange={(open) => {
          if (!open) setViewingId(null)
        }}
        sidebar={viewing === null ? null : <FileViewerSidebar doc={viewing} />}
        foot={
          viewing === null ? null : (
            <FileViewerFoot
              doc={viewing}
              onDelete={() =>
                void remove(viewing, 'server').then((gone) => {
                  if (gone) setViewingId(null)
                })
              }
            />
          )
        }
      />
      <LinkFolderDialog
        path={linkingFolder}
        recordName={recordName}
        inside={null}
        onOpenChange={(open) => {
          if (!open) setLinkingFolder(null)
        }}
      />
      {removeDialog}
    </div>
  )
}

/** The pine wash over the whole tab while files are dragged onto it. */
export function DropWash({
  count,
  recordName,
}: {
  count: number
  recordName: string
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 border border-dashed border-primary bg-selected"
    >
      <span className="text-ui">
        {count > 0
          ? `Drop ${String(count)} file${count === 1 ? '' : 's'} on ${recordName}`
          : `Drop on ${recordName}`}
      </span>
      <span className="mono text-micro text-graphite">
        kind guessed from each name · up to {formatBytes(MAX_UPLOAD_BYTES)} each
      </span>
    </div>
  )
}

/**
 * Extraction finishes on the worker, out of band, so nothing would otherwise
 * tell this page it happened. Poll while anything is pending, and stop —
 * `failed` is terminal, and an infinite poll on a broken worker is worse
 * than a stale row.
 */
function useExtractionPolling(
  documents: Documents,
  router: ReturnType<typeof useRouter>,
) {
  const waiting = documents.some((d) => d.extractionStatus === 'pending')
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    if (!waiting) {
      setAttempts(0)
      return
    }
    if (attempts >= 10) return
    const timer = setTimeout(() => {
      setAttempts((n) => n + 1)
      void router.invalidate()
    }, 2500)
    return () => clearTimeout(timer)
  }, [waiting, attempts, router])
}

/**
 * Read deck (SPA-90). The gate is asked once per Files tab, not per row:
 * the extract lane must be routed — with a live credential, and to a local
 * model when the record resolves sensitive — at this record's sensitivity,
 * or no row shows the button. A row shows it when its document's kind is
 * `deck` and its text is extracted, and on nothing else: however the kind
 * was set — the filename guesser, a bound folder, an accepted classify
 * suggestion — the row reads `kind` alone.
 *
 * The read runs on the worker. While any deck is reading the tab polls
 * `readDeckStatus`; a read that settles says so in a toast — the suggestions
 * are in Review, or the job's own failure sentence — and the button
 * comes back.
 *
 * Read deck and summarize (SPA-100) sits beside it when the synthesize lane
 * can run too: the same job and key with this record as the summary's home,
 * one two-step run — so the status, the polling and the toast are shared.
 */
/** A document's read state; a deck the tab has not asked about is idle. */
function stateOf(
  statuses: Record<string, DeckStatus>,
  id: string,
): DeckStatus['state'] {
  return Object.hasOwn(statuses, id) ? statuses[id].state : 'idle'
}

function useDeckReader(
  entityId: string,
  documents: Documents,
): (doc: Documents[number]) => DeckReader | null {
  const [routed, setRouted] = useState(false)
  const [synthesizes, setSynthesizes] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, DeckStatus>>({})
  const [pressed, setPressed] = useState<Array<string>>([])
  const previous = useRef<Record<string, DeckStatus>>({})

  const deckIds = documents
    .filter((d) => offersReadDeck(d, true))
    .map((d) => d.id)
  const deckKey = deckIds.join(',')

  useEffect(() => {
    const live = { current: true }
    void (async () => {
      try {
        const [lane, synthesize, sensitivity] = await Promise.all([
          isLaneRouted({ data: { lane: 'extract' } }),
          isLaneRouted({ data: { lane: 'synthesize' } }),
          getEntitySensitivity({ data: { entityId } }),
        ])
        if (!live.current) return
        setRouted(lane[sensitivity.sensitivity])
        setSynthesizes(synthesize[sensitivity.sensitivity])
      } catch {
        // A gate that cannot tell is closed: no button rather than a toast.
        if (live.current) {
          setRouted(false)
          setSynthesizes(false)
        }
      }
    })()
    return () => {
      live.current = false
    }
  }, [entityId])

  const refresh = useCallback(async () => {
    const ids = deckKey === '' ? [] : deckKey.split(',')
    if (ids.length === 0) return
    const next = await readDeckStatus({ data: { documentIds: ids } })
    for (const [id, status] of Object.entries(next)) {
      if (stateOf(previous.current, id) !== 'reading') continue
      if (status.state === 'failed') toast.error(status.message)
      if (status.state === 'done')
        toast.success('Deck read · the suggestions are in Review')
    }
    previous.current = next
    setStatuses(next)
    setPressed((p) => p.filter((id) => stateOf(next, id) === 'reading'))
  }, [deckKey])

  useEffect(() => {
    if (!routed) return
    void refresh().catch(() => undefined)
  }, [routed, refresh])

  const anyReading =
    pressed.length > 0 ||
    Object.values(statuses).some((s) => s.state === 'reading')

  useEffect(() => {
    if (!anyReading) return
    const timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [anyReading, refresh])

  async function read(documentId: string, summarize: boolean) {
    setPressed((p) => [...p, documentId])
    previous.current = {
      ...previous.current,
      [documentId]: { state: 'reading' },
    }
    try {
      const result = summarize
        ? await readDeckAndSummarize({
            data: { documentId, recordId: entityId },
          })
        : await readDeck({ data: { documentId } })
      if (result.status === 'already-reading') toast.message('Already reading')
      if (result.status === 'queue-unavailable') {
        toast.error('The worker queue is unreachable; try again shortly')
        setPressed((p) => p.filter((id) => id !== documentId))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read deck')
      setPressed((p) => p.filter((id) => id !== documentId))
    }
  }

  return (doc) => {
    if (!offersReadDeck(doc, routed)) return null
    return {
      reading:
        pressed.includes(doc.id) || stateOf(statuses, doc.id) === 'reading',
      onRead: () => void read(doc.id, false),
      onReadAndSummarize: synthesizes ? () => void read(doc.id, true) : null,
    }
  }
}
