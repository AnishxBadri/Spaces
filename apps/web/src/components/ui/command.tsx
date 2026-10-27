'use client'

import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'

import { cn } from '#/lib/utils.ts'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog.tsx'

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-paper text-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  children,
  className,
  // Forwarded to cmdk. Set false when results are already ranked by the
  // server — cmdk's own scorer would re-filter them and silently drop the
  // fuzzy matches a trigram index was there to find.
  shouldFilter,
  overlayClassName,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  /** The scrim's ground; the dialog's default when omitted. */
  overlayClassName?: string
  shouldFilter?: boolean | undefined
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {/* A size exception: Cmd-K owns its own size, its caller's className. */}
      <DialogContent
        size="m"
        className={cn('overflow-hidden p-0 sm:max-w-none', className)}
        {...(overlayClassName === undefined ? {} : { overlayClassName })}
      >
        <Command {...(shouldFilter === undefined ? {} : { shouldFilter })}>
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  mode,
  aside,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  /** The mode at the head of the input; a pine `›` when omitted. */
  mode?: React.ReactNode
  /** The input's right lane. */
  aside?: React.ReactNode
}) {
  return (
    // The prompt: the mode, then the query, the right lane after. 52px of
    // bone, hairline under (the palette's head).
    <div
      data-slot="command-input-wrapper"
      className="flex h-13 shrink-0 items-center gap-3 border-b border-hairline bg-bone px-4"
    >
      {mode ?? (
        <span aria-hidden className="mono text-ui text-primary">
          ›
        </span>
      )}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-full w-full min-w-0 bg-transparent text-title outline-hidden placeholder:text-graphite disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
      {aside ? (
        <span className="hidden shrink-0 mono text-micro text-graphite sm:inline">
          {aside}
        </span>
      ) : null}
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'max-h-[360px] scroll-py-1.5 overflow-x-hidden overflow-y-auto p-1.5',
        className,
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="px-2.5 py-5 text-label text-graphite"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden text-foreground [&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-6 [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:label-caps [&_[cmdk-group-heading]]:text-graphite [&_[cmdk-group]:not([hidden])_~&]:pt-2',
        className,
      )}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        // Highlighted option = bone (No-Bar Rule); the ↵ hint shows on it.
        "relative flex min-h-8 cursor-default items-center gap-2.5 rounded-none px-2.5 py-1.5 text-ui outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-bone [&_[data-hint]]:invisible data-[selected=true]:[&_[data-hint]]:visible [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-graphite",
        className,
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
}
