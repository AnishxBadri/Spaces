import * as React from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'
import { cn } from '#/lib/utils.ts'

/** A 2×2 cell of the mark's 16 grid, by its top-left corner. */
type Cell = readonly [x: number, y: number]

/** The working mark's two checker halves, shown in turn. */
const WORKING_FRAMES: readonly [ReadonlyArray<Cell>, ReadonlyArray<Cell>] = [
  [
    [7, 1],
    [7, 5],
    [1, 7],
    [5, 7],
    [9, 7],
    [13, 7],
    [7, 9],
    [7, 13],
  ],
  [
    [7, 3],
    [5, 5],
    [9, 5],
    [3, 7],
    [7, 7],
    [11, 7],
    [5, 9],
    [9, 9],
    [7, 11],
  ],
]

/**
 * The mark of everything a model does: a pixel star with a companion square,
 * on a 16 grid. On paper the star is ink and the companion pine; on an ink
 * cell (`onInk`) both are paper.
 * - `working` alternates its two checker halves; under reduced motion it
 *   holds the first.
 */
export function AskMark({
  onInk = false,
  working = false,
  className,
}: {
  onInk?: boolean
  working?: boolean
  className?: string
}) {
  return (
    <svg
      data-ask-mark
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className={cn(
        'size-4 shrink-0',
        onInk ? 'text-paper' : 'text-foreground',
        className,
      )}
    >
      {working ? (
        WORKING_FRAMES.map((cells, i) => (
          <g
            key={i}
            data-ask-frame={i + 1}
            className={i === 0 ? 'ask-frame-a' : 'ask-frame-b'}
          >
            {cells.map(([x, y]) => (
              <rect
                key={`${x},${y}`}
                x={x}
                y={y}
                width="2"
                height="2"
                fill="currentColor"
              />
            ))}
          </g>
        ))
      ) : (
        <>
          <rect x="7" y="1" width="2" height="14" fill="currentColor" />
          <rect x="1" y="7" width="14" height="2" fill="currentColor" />
          <rect x="5" y="5" width="6" height="6" fill="currentColor" />
          <rect
            x="13"
            y="1"
            width="2"
            height="2"
            fill="currentColor"
            className={onInk ? undefined : 'text-primary'}
          />
        </>
      )}
    </svg>
  )
}

/** The default form, 32px, and the small one for a labelled AI action. */
export type AskButtonSize = 'default' | 'sm'

/**
 * The Ask control: a solid ink cell holding the mark, joined to a bordered
 * label. Without `children` it is the cell alone, its label in a tooltip.
 * - `working` animates the mark and the label says what it is doing.
 * - `open`: Ask is open on this subject, and the whole button is ink.
 * - Hover turns the cell pine and the label bone.
 * Props and ref reach the `<button>`, so a Radix `asChild` trigger can wear it.
 */
export function AskButton({
  size = 'default',
  working = false,
  open = false,
  label,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'button'>, 'aria-label'> & {
  size?: AskButtonSize
  working?: boolean
  open?: boolean
  /** The icon-only form's accessible name and tooltip. */
  label?: string
}) {
  const iconOnly = children === undefined || children === null
  const button = (
    <button
      type="button"
      data-ask-button
      data-open={open ? '' : undefined}
      aria-label={iconOnly ? label : undefined}
      aria-busy={working || undefined}
      className={cn(
        'group/ask focus-ring inline-flex shrink-0 items-center rounded-md border border-hairline text-foreground transition-[background-color,transform] duration-100 ease-out-quart active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-[1.625rem] text-label' : 'h-8 text-ui',
        open ? 'bg-hairline text-paper' : 'bg-paper hover:bg-bone',
        iconOnly && 'bg-hairline',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center self-stretch bg-hairline transition-colors duration-100 ease-out-quart',
          size === 'sm' ? 'w-6' : 'w-7.5',
          !open && !working && 'group-hover/ask:bg-primary',
        )}
      >
        <AskMark onInk working={working} />
      </span>
      {iconOnly ? null : (
        <span
          className={cn(
            'pr-3 whitespace-nowrap',
            size === 'sm' ? 'pl-2' : 'pl-2.5',
            working && !open && 'text-graphite',
          )}
        >
          {children}
        </span>
      )}
    </button>
  )
  if (!iconOnly || label === undefined) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
