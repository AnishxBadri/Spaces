'use client'

import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { cn } from '#/lib/utils.ts'

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-modal bg-hairline/50 ease-out-quart data-[state=closed]:animate-out data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:duration-[180ms] data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

/** The four window widths: a confirm, a form, a reading window, the file viewer. */
export type WindowSize = 's' | 'm' | 'l' | 'viewer'

const WINDOW_SIZE: Record<WindowSize, string> = {
  s: 'sm:max-w-[27.5rem]',
  m: 'sm:max-w-[35rem]',
  l: 'sm:max-w-[48rem] max-h-[85vh] flex flex-col',
  viewer: 'sm:max-w-[72rem] h-[85vh] p-0 flex flex-col',
}

/** How far a window opened from a window sits below its parent's top edge. */
export const STACK_STEP_PX = 56

/** Windows open at once: a parent and the one it opened. */
export const MAX_WINDOWS = 2

/** The window a nested one opens from: how deep it is, and its sheet. */
type WindowFrame = { depth: number; sheet: HTMLElement | null }

const WindowStack = React.createContext<WindowFrame>({ depth: 0, sheet: null })

/**
 * The sheet of the window this sits in, or null outside one: a popover in a
 * window keeps inside it.
 */
function useWindowSheet(): HTMLElement | null {
  return React.useContext(WindowStack).sheet
}

/**
 * A window; `size` is its width, which a caller never spells.
 * - Opened from inside another window it steps down under its parent:
 *   `STACK_STEP_PX` below the parent's top, over a lighter scrim of its own.
 * - A third window is refused: in development opening one throws.
 * - Esc closes the top window only (Radix's dismissable layers).
 */
function DialogContent({
  size,
  className,
  overlayClassName,
  style,
  ref,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  size: WindowSize
  /** The scrim's ground, when the window asks for its own. */
  overlayClassName?: string
}) {
  const parent = React.useContext(WindowStack)
  if (import.meta.env.DEV && parent.depth >= MAX_WINDOWS)
    throw new Error(
      `A window was opened from a stacked window: at most ${MAX_WINDOWS} are open at once.`,
    )
  const nested = parent.depth > 0
  const [sheet, setSheet] = React.useState<HTMLElement | null>(null)
  const [top, setTop] = React.useState<number | null>(null)
  // Measured before paint, so a stacked window never lands centred first.
  React.useLayoutEffect(() => {
    if (!nested || parent.sheet === null) return
    setTop(parent.sheet.getBoundingClientRect().top + STACK_STEP_PX)
  }, [nested, parent.sheet])
  const sheetRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      setSheet(node)
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )
  const frame = React.useMemo(
    () => ({ depth: parent.depth + 1, sheet }),
    [parent.depth, sheet],
  )
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay
        className={cn(nested && 'bg-hairline/30', overlayClassName)}
      />
      <DialogPrimitive.Content
        ref={sheetRef}
        data-slot="dialog-content"
        data-window-depth={frame.depth}
        className={cn(
          // Overlay anatomy: paper sheet, 1px ink, the solid shadow of a
          // window over the scrim (dither would vanish there). The 20px body
          // padding is the sheet's; DialogHeader and DialogFooter break out
          // of it to run edge to edge. It lands by its solid offset growing
          // 0→3px in three steps (`window-land`), never by scaling.
          'fixed top-[50%] left-[50%] z-modal flex w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col rounded-none border border-hairline bg-paper p-5 shadow-solid ease-out-quart outline-none data-[state=closed]:animate-out data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=open]:window-land',
          WINDOW_SIZE[size],
          nested && 'translate-y-0',
          className,
        )}
        // Stepped down, it stops 16px short of the viewport's foot rather
        // than running off it.
        style={
          top === null
            ? style
            : { ...style, top, maxHeight: `calc(100vh - ${top + 16}px)` }
        }
        {...props}
      >
        <WindowStack.Provider value={frame}>{children}</WindowStack.Provider>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      // 48px head on bone: serif title, mono context beside it, nothing
      // right; hairline under. The one close is the foot's Cancel — Escape
      // still closes, and is never printed.
      className={cn(
        '-mx-5 -mt-5 mb-5 flex min-h-12 flex-row flex-wrap items-baseline gap-x-2.5 border-b border-hairline bg-bone px-5 py-3 text-left',
        className,
      )}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  note,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  /** Mono line on the left: what will happen, and the counts. */
  note?: React.ReactNode
}) {
  return (
    <div
      data-slot="dialog-footer"
      // 52px bone foot: note left, then Cancel beside the primary. Neither
      // prints a key; a primary's ⌘↵ is in its tooltip. Cancel is the
      // dialog's one close.
      // - The note wraps, never truncates: it is a cost, privacy or
      //   irreversibility line, and a cut one says nothing.
      className={cn(
        '-mx-5 mt-5 -mb-5 flex min-h-13 flex-row items-center justify-end gap-2 border-t border-rule bg-bone px-5 py-2.5',
        className,
      )}
      {...props}
    >
      {note ? (
        <span className="mr-auto min-w-0 mono text-micro break-words text-graphite">
          {note}
        </span>
      ) : null}
      {children}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-serif text-lg leading-5.5 font-semibold', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('mono text-micro text-graphite', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  useWindowSheet,
}
