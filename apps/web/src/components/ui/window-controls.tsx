import * as React from 'react'
import { Slot } from 'radix-ui'

import { icon } from '#/components/icons'
import { DialogClose } from './dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'
import { cn } from '#/lib/utils.ts'

/**
 * The close's colour under the pointer. Crimson otherwise means destructive;
 * the window's close is drawn this way and still waits on the owner, so it
 * lives here and nowhere else.
 */
const CLOSE_HOVER = 'hover:bg-destructive'

/** The pixel ×: nine 2px cells on the 16 grid. */
const CROSS_CELLS: ReadonlyArray<readonly [x: number, y: number]> = [
  [3, 3],
  [5, 5],
  [7, 7],
  [9, 9],
  [11, 11],
  [11, 3],
  [9, 5],
  [5, 9],
  [3, 11],
]

function PixelCross() {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className="size-4 shrink-0"
    >
      {CROSS_CELLS.map(([x, y]) => (
        <rect
          key={`${x},${y}`}
          x={x}
          y={y}
          width="2"
          height="2"
          fill="currentColor"
        />
      ))}
    </svg>
  )
}

/**
 * A window's close: a 32px solid ink cell with the pixel ×, its tooltip
 * `Close`. It closes the window it sits in; `onClick` runs first, for a
 * window that lands an edit on its way out.
 */
export function WindowClose({
  className,
  ...props
}: Omit<React.ComponentProps<'button'>, 'children'>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DialogClose asChild>
          <button
            type="button"
            aria-label="Close"
            data-window-close
            className={cn(
              'focus-ring flex size-8 shrink-0 items-center justify-center rounded-md bg-hairline text-paper transition-[background-color,transform] duration-100 ease-out-quart active:scale-[0.97]',
              CLOSE_HOVER,
              className,
            )}
            {...props}
          >
            <PixelCross />
          </button>
        </DialogClose>
      </TooltipTrigger>
      <TooltipContent>Close</TooltipContent>
    </Tooltip>
  )
}

/**
 * `Open as a page`, for a window whose thing also has a page: a plain
 * bordered 32px button with the maximise glyph, its name in the tooltip.
 * `asChild` wears the caller's link, which brings no children of its own.
 */
export function OpenAsPage({
  asChild = false,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Comp
          {...(asChild ? {} : { type: 'button' as const })}
          aria-label="Open as a page"
          data-open-as-page
          className={cn(
            'focus-ring flex size-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-paper text-foreground transition-[background-color,transform] duration-100 ease-out-quart hover:bg-bone active:scale-[0.97]',
            className,
          )}
          {...props}
        >
          {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : null}
          <icon.openAsPage aria-hidden className="size-4" />
        </Comp>
      </TooltipTrigger>
      <TooltipContent>Open as a page</TooltipContent>
    </Tooltip>
  )
}

/**
 * The end of a window's actions: `Open as a page` when the thing has a page,
 * then a rule divider, then the close alone.
 */
export function WindowControls({
  page,
  onClose,
}: {
  /** An `OpenAsPage`, for a window whose thing has a page. */
  page?: React.ReactNode
  onClose?: () => void
}) {
  return (
    <div data-window-controls className="flex shrink-0 items-center gap-2">
      {page}
      <span aria-hidden className="h-5 w-px shrink-0 bg-rule" />
      <WindowClose {...(onClose === undefined ? {} : { onClick: onClose })} />
    </div>
  )
}
