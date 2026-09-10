'use client'

import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { cn } from '#/lib/utils.ts'
import { Button } from '#/components/ui/button.tsx'

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
        'fixed inset-0 z-50 bg-black/50 ease-out-quart data-[state=closed]:animate-out data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:duration-[180ms] data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // P8 — overlay anatomy: paper sheet, 1px ink, 3px hard shadow. The
          // 20px body padding is the sheet's; DialogHeader and DialogFooter
          // break out of it to run edge to edge.
          'fixed top-[50%] left-[50%] z-50 flex w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col rounded-none border border-hairline bg-background p-5 shadow-[3px_3px_0_0_var(--hairline)] ease-out-quart outline-none data-[state=closed]:animate-out data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:duration-[180ms] data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          // The close affordance is the key that closes: `esc`, mono, in the
          // head's right lane.
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="focus-ring absolute top-[0.9375rem] right-5 mono text-micro text-graphite transition-colors duration-150 hover:text-foreground disabled:pointer-events-none"
          >
            esc<span className="sr-only">ape — close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      // 44px head: serif title, mono context beside it, hairline under.
      className={cn(
        '-mx-5 -mt-5 mb-5 flex min-h-11 flex-row flex-wrap items-baseline gap-x-2.5 border-b border-hairline px-5 py-[0.6875rem] pr-14 text-left',
        className,
      )}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  note,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
  /** Mono line on the left: what will happen, and the counts. */
  note?: React.ReactNode
}) {
  return (
    <div
      data-slot="dialog-footer"
      // 52px bone foot: note left, buttons right; the primary carries ⌘↵.
      className={cn(
        '-mx-5 mt-5 -mb-5 flex min-h-13 flex-row items-center justify-end gap-2 border-t border-rule bg-bone px-5 py-2.5',
        className,
      )}
      {...props}
    >
      {note ? (
        <span className="mr-auto min-w-0 truncate mono text-micro text-graphite">
          {note}
        </span>
      ) : null}
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
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
      className={cn(
        'font-serif text-lg leading-[1.375rem] font-semibold',
        className,
      )}
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
