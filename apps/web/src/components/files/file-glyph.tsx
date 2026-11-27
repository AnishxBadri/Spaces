import { useId } from 'react'
import type { FileType } from '#/lib/documents/files-tab'
import { cn } from '#/lib/utils'

/**
 * The Files kit's glyphs: 1px ink line drawings in a 28px slot, the page's
 * cut corner the same cut as the stamp and the open tab.
 * - A file glyph says the type (`PDF`, `XLS`), never the kind.
 * - A Google Doc, Sheet or Slides file wears its product mark instead.
 * - Folders are only ever a bound Drive folder and its subfolders.
 * Stroke and fill are `currentColor`, so a row tints the glyph by its text.
 */

const LABELS: Readonly<Record<FileType, string | null>> = {
  pdf: 'PDF',
  doc: 'DOC',
  xls: 'XLS',
  ppt: 'PPT',
  img: 'IMG',
  txt: 'TXT',
  zip: 'ZIP',
  eml: 'EML',
  file: null,
  'google-doc': null,
  'google-sheet': null,
  'google-slides': null,
}

/** The page outline with its cut corner; dashed while it is only a link. */
function Page({ dashed = false }: { dashed?: boolean }) {
  return (
    <>
      <path
        d="M6.5 3.5H17.5L21.5 7.5V24.5H6.5Z"
        fill="var(--paper)"
        stroke="currentColor"
        strokeDasharray={dashed ? '2 1.5' : undefined}
      />
      <path d="M17.5 3.5V7.5H21.5" fill="none" stroke="currentColor" />
    </>
  )
}

/** Google's product marks, drawn in ink: a block with its own inner figure. */
function GoogleMark({ type }: { type: FileType }) {
  return (
    <g>
      <rect x="10" y="11" width="8" height="9" fill="currentColor" />
      {type === 'google-doc' ? (
        <path
          d="M11.5 13.5H16.5M11.5 15.5H16.5M11.5 17.5H14.5"
          stroke="var(--paper)"
        />
      ) : type === 'google-sheet' ? (
        <path
          d="M11.5 13.5H16.5V18.5H11.5ZM11.5 16H16.5M14 13.5V18.5"
          fill="none"
          stroke="var(--paper)"
        />
      ) : (
        <rect
          x="11.5"
          y="13.5"
          width="5"
          height="4"
          fill="none"
          stroke="var(--paper)"
        />
      )}
    </g>
  )
}

export function FileGlyph({
  type,
  pending = false,
  className,
}: {
  type: FileType
  /** A link that has not become a file yet: dashed, with Drive's mark. */
  pending?: boolean
  className?: string
}) {
  const label = LABELS[type]
  return (
    <svg
      viewBox="0 0 28 28"
      aria-hidden
      data-glyph={pending ? 'link' : type}
      className={cn('size-7 shrink-0 text-foreground', className)}
    >
      <Page dashed={pending} />
      {pending ? (
        <g transform="translate(9 11) scale(0.625)">
          <path
            d="M5.6 2h4.8l4.8 8.3-2.4 4.2H3.2L.8 10.3Z"
            fill="currentColor"
          />
        </g>
      ) : label !== null ? (
        <text
          x="8"
          y="22"
          fontSize="5"
          fontFamily="var(--font-mono)"
          fill="currentColor"
        >
          {label}
        </text>
      ) : type === 'file' ? null : (
        <GoogleMark type={type} />
      )}
    </svg>
  )
}

/**
 * The glyph a file's head leads with: the cut-corner sheet at 40 by 48 with
 * its type set on it, casting the pine dither 4px down and right.
 */
export function FileGlyphLarge({
  type,
  className,
}: {
  type: FileType
  className?: string
}) {
  const dither = useId()
  const label = LABELS[type]
  return (
    <svg
      viewBox="0 0 44 52"
      aria-hidden
      data-glyph={type}
      data-glyph-size="large"
      shapeRendering="crispEdges"
      className={cn('h-13 w-11 shrink-0 text-foreground', className)}
    >
      <defs>
        <pattern id={dither} width="4" height="4" patternUnits="userSpaceOnUse">
          <rect x="0" y="0" width="2" height="2" fill="var(--primary)" />
          <rect x="2" y="2" width="2" height="2" fill="var(--primary)" />
        </pattern>
      </defs>
      {/* The shadow follows the sheet's cut: the corner casts none. */}
      <rect x="4" y="16" width="40" height="36" fill={`url(#${dither})`} />
      <rect x="4" y="4" width="29" height="12" fill={`url(#${dither})`} />
      <g shapeRendering="auto">
        <path
          d="M0.5 0.5H28.5L39.5 11.5V47.5H0.5Z"
          fill="var(--paper)"
          stroke="currentColor"
        />
        <path d="M28.5 0.5V11.5H39.5" fill="none" stroke="currentColor" />
      </g>
      {label !== null ? (
        <text
          x="20"
          y="35"
          textAnchor="middle"
          fontSize="11"
          fontWeight="600"
          fontFamily="var(--font-mono)"
          fill="currentColor"
        >
          {label}
        </text>
      ) : type === 'file' ? null : (
        <g transform="translate(-1 1) scale(1.5)">
          <GoogleMark type={type} />
        </g>
      )}
    </svg>
  )
}

export function FolderGlyph({
  bound = false,
  className,
}: {
  /** The bound Drive folder itself, rather than one of its subfolders. */
  bound?: boolean
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 28 28"
      aria-hidden
      data-glyph={bound ? 'bound-folder' : 'folder'}
      className={cn('size-7 shrink-0 text-foreground', className)}
    >
      <path
        d="M3.5 7.5H11L13 9.5H24.5V21.5H3.5Z"
        fill="var(--paper)"
        stroke="currentColor"
      />
      {bound ? (
        <g transform="translate(9 11) scale(0.625)">
          <path
            d="M5.6 2h4.8l4.8 8.3-2.4 4.2H3.2L.8 10.3Z"
            fill="currentColor"
          />
        </g>
      ) : null}
    </svg>
  )
}
