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
        'fixed inset-0 z-modal bg-black/50 ease-out-quart data-[state=closed]:animate-out data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:duration-[180ms] data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  overlayClassName,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** The scrim's ground, when the window asks for its own. */
  overlayClassName?: string
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // Overlay anatomy: paper sheet, 1px ink, the solid shadow of a
          // window over the scrim (dither would vanish there). The 20px body
          // padding is the sheet's; DialogHeader and DialogFooter break out
          // of it to run edge to edge.
          'fixed top-[50%] left-[50%] z-modal flex w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col rounded-none border border-hairline bg-paper p-5 shadow-solid ease-out-quart outline-none data-[state=closed]:animate-out data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:duration-[180ms] data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg',
          className,
        )}
        {...props}
      >
        {children}
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
      // 52px bone foot: note left, then Cancel beside the primary, which
      // carries ⌘↵. Cancel is the dialog's one close.
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
}
