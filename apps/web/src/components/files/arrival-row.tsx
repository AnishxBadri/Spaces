import { formatBytes } from '@spaces/core/documents'
import { AskMark } from '../ui/ask-control'
import { FileGlyph } from './file-glyph'
import { DitherBar } from './file-row'
import { dismissArrival } from '#/lib/documents/arrivals'
import type { Arrival } from '#/lib/documents/arrivals'
import { fileType } from '#/lib/documents/files-tab'
import { cn } from '#/lib/utils'

/**
 * A file still arriving in the `Unfiled` band, on the Files row's lanes so
 * its `×` stands where a read row's `···` does: a dithered bar while it
 * uploads, then the working mark and `Reading text` until the list reads
 * it, or why it was not added.
 */
export function ArrivalRow({
  arrival,
  onOpen,
}: {
  arrival: Arrival
  /** Opens the file an `Already here` row names. */
  onOpen: (id: string) => void
}) {
  const { state } = arrival
  const quiet = state.kind === 'already'
  return (
    <li
      data-arrival={state.kind}
      className="flex h-14 items-center gap-3 border-b border-rule px-(--inset)"
    >
      <FileGlyph
        type={fileType({
          filename: arrival.name,
          mime: arrival.mime,
          externalUrl: null,
        })}
        {...(quiet ? { className: 'text-graphite' } : {})}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            'min-w-0 truncate text-ui',
            quiet ? 'text-graphite' : 'text-foreground',
          )}
        >
          {arrival.name}
        </span>
        <ArrivalLine arrival={arrival} onOpen={onOpen} />
      </div>
      <span className="hidden w-47.5 shrink-0 truncate mono text-micro text-graphite xl:block">
        {quiet ? 'Not added' : formatBytes(arrival.sizeBytes)}
      </span>
      {/* The filed-under, source and day lanes a read row fills. */}
      <span aria-hidden className="hidden w-55 shrink-0 md:block" />
      <span aria-hidden className="hidden w-45 shrink-0 lg:block" />
      <span aria-hidden className="w-14 shrink-0" />
      <span className="flex w-6 shrink-0 justify-end">
        {state.kind === 'landed' ? null : (
          <button
            type="button"
            aria-label={
              state.kind === 'uploading'
                ? `Cancel ${arrival.name}`
                : `Dismiss ${arrival.name}`
            }
            onClick={() => dismissArrival(arrival.key)}
            className="focus-ring flex size-6 items-center justify-center rounded-md text-body text-graphite hover:text-foreground"
          >
            ×
          </button>
        )}
      </span>
    </li>
  )
}

/** The line under the name: progress, reading, or why it was not added. */
function ArrivalLine({
  arrival,
  onOpen,
}: {
  arrival: Arrival
  onOpen: (id: string) => void
}) {
  const { state } = arrival
  switch (state.kind) {
    case 'uploading':
      return (
        <span data-arrival-line className="flex h-4 items-center gap-2.5">
          <DitherBar fraction={state.progress} width={200} height={8} />
          <span className="tabular mono text-micro text-foreground">
            {Math.round(state.progress * 100)}%
          </span>
        </span>
      )
    case 'landed':
      return (
        <span
          data-arrival-line
          className="flex h-4 items-center gap-2 text-label text-graphite"
        >
          <AskMark working />
          Reading text
        </span>
      )
    case 'already': {
      const { existing } = state
      return (
        <span
          data-arrival-line
          className="flex h-4 min-w-0 items-center gap-2 text-label"
        >
          <span className="min-w-0 truncate text-graphite">
            Already here as {existing.filename}
            {existing.under === null ? '' : `, on ${existing.under}`}
          </span>
          <button
            type="button"
            onClick={() => onOpen(existing.id)}
            className="focus-ring shrink-0 rounded-md text-foreground underline underline-offset-2 hover:text-graphite"
          >
            Open
          </button>
        </span>
      )
    }
    case 'refused':
    case 'failed': {
      const words =
        state.kind === 'refused' ? `Not added · ${state.reason}` : state.reason
      return (
        <span
          data-arrival-line
          className="flex h-4 min-w-0 items-center gap-2 text-label"
        >
          <span aria-hidden className="size-1.5 shrink-0 bg-destructive" />
          <span title={words} className="min-w-0 truncate text-destructive">
            {words}
          </span>
        </span>
      )
    }
  }
}
