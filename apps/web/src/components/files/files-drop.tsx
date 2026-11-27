import { useId, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import { cellsFor } from '../dither'
import { addFiles } from '#/lib/documents/arrivals'

/**
 * The Files page as one drop target: files dragged anywhere over it show a
 * dashed sheet over the body, and dropped they land unfiled as rows at the
 * head of `Unfiled`. No dialog.
 * - Only a drag that carries files arms it; text or a link dragged across
 *   the page does nothing.
 * - A window opened over the page (a file's) is portalled out of it but
 *   still bubbles here through React; a drop there is not the page's.
 */
export function FilesDrop({
  head,
  children,
}: {
  /** The page head: a drop on it counts, the sheet stays under it. */
  head: ReactNode
  children: ReactNode
}) {
  const [count, setCount] = useState<number | null>(null)
  const depth = useRef(0)

  const ours = (e: DragEvent<HTMLDivElement>) =>
    e.dataTransfer.types.includes('Files') &&
    e.target instanceof Node &&
    e.currentTarget.contains(e.target)

  return (
    <div
      data-files-drop
      className="flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!ours(e)) return
        e.preventDefault()
        depth.current += 1
        setCount(
          [...e.dataTransfer.items].filter((i) => i.kind === 'file').length,
        )
      }}
      onDragOver={(e) => {
        if (!ours(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!ours(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setCount(null)
      }}
      onDrop={(e) => {
        if (!ours(e)) return
        e.preventDefault()
        depth.current = 0
        setCount(null)
        addFiles(e.dataTransfer.files)
      }}
    >
      {head}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
        {count === null ? null : <DropSheet count={count} />}
      </div>
    </div>
  )
}

/** The dashed sheet: the drawing, `Drop 3 files`, and where they go. */
function DropSheet({ count }: { count: number }) {
  return (
    <div
      aria-hidden
      data-files-drop-sheet
      className="pointer-events-none absolute inset-0 z-10 flex border border-hairline bg-bone p-3"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-3.5 border border-dashed border-hairline bg-paper">
        <FilesDrawing />
        <span className="font-serif text-head font-semibold text-foreground">
          {count === 0
            ? 'Drop files'
            : `Drop ${String(count)} file${count === 1 ? '' : 's'}`}
        </span>
        <span className="mono text-micro text-graphite">
          They land unfiled · up to {formatBytes(MAX_UPLOAD_BYTES)} each
        </span>
      </div>
    </div>
  )
}

/**
 * A sheet going into a folder whose tab and back are pine dither: the
 * Paper drawing, in the page's tokens.
 */
function FilesDrawing() {
  const base = useId()
  const back = `${base}-back`
  const tab = `${base}-tab`
  const pattern = (id: string, level: number) => (
    <pattern id={id} width="8" height="8" patternUnits="userSpaceOnUse">
      {cellsFor(level).map(([x, y]) => (
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width="2"
          height="2"
          fill="var(--primary)"
        />
      ))}
    </pattern>
  )
  return (
    <svg
      width="160"
      height="120"
      viewBox="0 0 160 120"
      shapeRendering="crispEdges"
      className="shrink-0"
    >
      <defs>
        {pattern(back, 8)}
        {pattern(tab, 12)}
      </defs>
      <path
        d="M36,38 L72,38 L80,46 L140,46 L140,108 L36,108 Z"
        fill={`url(#${back})`}
      />
      <rect
        x="46.5"
        y="18.5"
        width="67"
        height="49"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="56" y="30" width="40" height="2" fill="var(--rule)" />
      <rect x="56" y="40" width="48" height="2" fill="var(--rule)" />
      <path
        d="M28.5,46.5 L132.5,46.5 L132.5,100.5 L28.5,100.5 Z"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <path
        d="M28.5,30.5 L64.5,30.5 L72.5,38.5 L72.5,46.5 L28.5,46.5 Z"
        fill={`url(#${tab})`}
        stroke="var(--hairline)"
      />
    </svg>
  )
}
