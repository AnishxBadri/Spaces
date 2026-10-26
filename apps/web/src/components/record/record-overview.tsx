import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { DocumentPreview } from '#/components/document-preview'
import { EmailModal } from '#/components/email-dialog'
import { FileGlyph } from '#/components/files/file-glyph'
import { openFile } from '#/components/files/file-row'
import type { RecordDocument } from '#/components/files/types'
import { FileViewerSidebar } from '#/components/files/viewer-sidebar'
import { Band, EmptyRow } from '#/components/ledger-section'
import { ThreadRow } from '#/components/record/thread-row'
import type { ThreadItem } from '#/components/record/thread-row'
import { TasksBand } from '#/components/tasks-rail'
import { fileType } from '#/lib/documents/files-tab'
import type { RecordTab } from '#/lib/records/record-tabs'
import { shownReadouts } from '#/lib/records/overview'
import type { OverviewReadout } from '#/lib/records/overview'
import { latestThreads } from '#/lib/timeline/threads'
import { cn } from '#/lib/utils'

/**
 * A record's Overview tab, top to bottom: the readouts that have a value,
 * the open tasks with their composer, the latest three threads and the
 * latest three files — each group a band ending on a link to its tab. A
 * group with nothing in it is its one `Name +` row, so a first-run record
 * reads `Tasks +`, `Interactions +`, `Files +` and nothing else.
 */

/** How many threads and files the Overview lists before its links. */
const LATEST = 3

/** A timeline row Overview reads: interactions are threads, the rest pass. */
type TimelineRow =
  | (ThreadItem & {
      type: 'interaction'
      threadId: string | null
    })
  | { type: 'macro' | 'attrs' | 'ledger' }

export function RecordOverview({
  record,
  readouts,
  timeline,
  documents,
  onTab,
  logInteraction,
}: {
  record: { id: string; name: string; kind: string }
  readouts: ReadonlyArray<OverviewReadout>
  timeline: ReadonlyArray<TimelineRow>
  documents: ReadonlyArray<RecordDocument>
  onTab: (tab: RecordTab) => void
  /**
   * Wraps the empty Interactions row in the log window; without it the row
   * opens the Interactions tab.
   */
  logInteraction?: ((trigger: ReactElement) => ReactNode) | undefined
}) {
  const shown = shownReadouts(readouts)
  const threads = latestThreads(
    timeline.filter(
      (r): r is Extract<TimelineRow, { type: 'interaction' }> =>
        r.type === 'interaction',
    ),
    LATEST,
  )
  const files = [...documents]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, LATEST)

  return (
    <div data-overview className="flex flex-col">
      {shown.length > 0 ? (
        <div
          data-overview-readouts
          className="flex h-19 shrink-0 overflow-x-auto border-b border-rule px-3"
        >
          {shown.map((r, i) => (
            <div
              key={r.label}
              data-readout
              className={cn(
                'flex shrink-0 flex-col justify-center gap-0.5',
                i === 0 ? 'w-55 border-r border-rule' : 'w-45 pl-4',
              )}
            >
              <span
                className={cn(
                  'truncate mono text-page leading-6.5',
                  r.tone === 'bad' ? 'text-destructive' : 'text-foreground',
                )}
              >
                {r.value}
              </span>
              <span className="truncate text-label text-graphite">
                {r.label}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <TasksBand
        entityId={record.id}
        entityName={record.name}
        entityKind={record.kind}
      />

      {threads.length === 0 ? (
        logInteraction ? (
          logInteraction(<EmptyRow name="Interactions" />)
        ) : (
          <EmptyRow name="Interactions" onAdd={() => onTab('interactions')} />
        )
      ) : (
        <section aria-label="Latest" className="flex flex-col">
          <Band
            label="Latest"
            link={
              <TabLink onClick={() => onTab('interactions')}>
                All interactions ›
              </TabLink>
            }
          />
          <ul>
            {threads.map((t) => (
              <ThreadRow
                key={t.row.id}
                item={t.row}
                messages={t.messages}
                tab="overview"
              />
            ))}
          </ul>
          <EmailModal recordId={record.id} />
        </section>
      )}

      {files.length === 0 ? (
        <EmptyRow name="Files" onAdd={() => onTab('files')} />
      ) : (
        <OverviewFiles
          recordId={record.id}
          files={files}
          onAll={() => onTab('files')}
        />
      )}
    </div>
  )
}

/** A band's way out to a tab: sans graphite, ink on hover. */
function TabLink({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring hover:text-foreground"
    >
      {children}
    </button>
  )
}

/**
 * The latest files: 40px rows of the type glyph, the name (which opens the
 * viewer, or Google for a Google file), who filed it and the day.
 */
function OverviewFiles({
  recordId,
  files,
  onAll,
}: {
  recordId: string
  files: ReadonlyArray<RecordDocument>
  onAll: () => void
}) {
  const { today } = useClock()
  const [viewingId, setViewingId] = useState<string | null>(null)
  const viewing = files.find((d) => d.id === viewingId) ?? null
  return (
    <section aria-label="Files" className="flex flex-col">
      <Band
        label="Files"
        link={<TabLink onClick={onAll}>All files ›</TabLink>}
      />
      <ul>
        {files.map((doc) => (
          <li
            key={doc.id}
            data-file={doc.id}
            className="flex h-ledger-row items-center gap-3 border-b border-rule px-3"
          >
            <FileGlyph type={fileType(doc)} />
            <button
              type="button"
              onClick={() => openFile(doc, () => setViewingId(doc.id))}
              className="focus-ring min-w-0 flex-1 truncate text-left text-ui text-foreground hover:underline"
            >
              {doc.filename}
            </button>
            <span
              data-filed-by
              className="w-63 shrink-0 truncate text-label text-graphite"
            >
              {doc.uploadedByName ?? ''}
            </span>
            <span className="w-18 shrink-0 text-right mono text-micro text-graphite">
              {formatDay(doc.createdAt, today)}
            </span>
          </li>
        ))}
      </ul>
      <DocumentPreview
        doc={viewing}
        onOpenChange={(open) => {
          if (!open) setViewingId(null)
        }}
        sidebar={
          viewing === null ? null : (
            <FileViewerSidebar doc={viewing} recordId={recordId} />
          )
        }
      />
    </section>
  )
}
