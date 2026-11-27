import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { Button } from '#/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog.tsx'
import { cn } from '#/lib/utils.ts'

export type ConfirmOptions = {
  /** Serif question: "Delete pitch.pdf?" */
  title: string
  /** One sans sentence saying what happens, and what does not. */
  body?: ReactNode
  /**
   * The things affected — name left, mono meta right — when there are
   * several; `icon` leads a row, a kind icon where the kinds are mixed.
   */
  rows?: Array<{ name: string; meta?: string; icon?: ReactNode }>
  /**
   * The verb on the acting button: "Delete", "Archive 3". Omitted, the sheet
   * is a notice — one way out and no button that promises something the
   * server has already refused (the mandate's note).
   */
  action?: string
  /** The safe way out; `Cancel` when omitted. */
  keep?: string
  /** The foot's mono line: what cannot be taken back ("Can't be undone"). */
  note?: string
  /** Destructive is the default — that is what confirms are for. */
  kind?: 'destructive' | 'primary'
  /**
   * The drawn confirm: the picture on bone at the left, the question beside
   * it on paper, with no head band.
   */
  drawing?: ReactNode
  /** Under the title: the thing's name, then its one facts line. */
  subject?: { name: string; facts: string }
}

/**
 * The destructive confirm: an S window whose bone head band holds the serif
 * question; on paper under it, one sentence and an optional ledger of what is
 * affected on a rule border; then the 52px bone foot: the note, Cancel, and
 * the acting button, whose tooltip carries ⌘↵. Focus lands on Cancel; the
 * destructive choice is one key further away. Given a `drawing`, the head
 * band gives way to the picture on bone beside the question.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  options,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: ConfirmOptions
  onConfirm: () => void
}) {
  const kind = options.kind ?? 'destructive'
  const rows = options.rows ?? []
  const hasBody = Boolean(options.body) || rows.length > 0
  const keep = useRef<HTMLButtonElement>(null)
  const drawn = options.drawing !== undefined
  const foot = (
    <DialogFooter
      className={cn('border-rule', drawn && 'mx-0 mt-0 mb-0 border-hairline')}
      {...(options.note === undefined ? {} : { note: options.note })}
    >
      <DialogClose asChild>
        <Button ref={keep} variant="outline">
          {options.keep ?? 'Cancel'}
        </Button>
      </DialogClose>
      {options.action === undefined ? null : (
        <Button
          variant={kind === 'destructive' ? 'destructive' : 'default'}
          shortcut="⌘↵"
          onClick={onConfirm}
        >
          {options.action}
        </Button>
      )}
    </DialogFooter>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="s"
        flush={drawn}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          keep.current?.focus()
        }}
        onKeyDown={(e) => {
          if (
            options.action !== undefined &&
            (e.metaKey || e.ctrlKey) &&
            e.key === 'Enter'
          ) {
            e.preventDefault()
            onConfirm()
          }
        }}
      >
        {drawn ? (
          <div data-confirm-drawn className="flex">
            <div
              aria-hidden
              className="flex w-38 shrink-0 items-center justify-center border-r border-hairline bg-bone px-4 py-5"
            >
              {options.drawing}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-2.5 px-4 py-5">
              <DialogTitle>{options.title}</DialogTitle>
              {options.subject === undefined ? null : (
                <DialogDescription className="flex flex-col gap-0.5 font-sans">
                  <span className="truncate text-ui leading-5 font-medium text-foreground">
                    {options.subject.name}
                  </span>
                  <span className="text-label text-graphite">
                    {options.subject.facts}
                  </span>
                </DialogDescription>
              )}
              {options.body ? (
                <p className="text-ui leading-4.75">{options.body}</p>
              ) : null}
              <ConfirmLedger rows={rows} />
            </div>
          </div>
        ) : (
          <>
            <DialogHeader
              className={cn('flex-nowrap items-center', !hasBody && 'mb-0')}
            >
              <DialogTitle>{options.title}</DialogTitle>
            </DialogHeader>
            {hasBody ? (
              <div className="flex flex-col gap-2.5">
                {options.body ? (
                  <DialogDescription className="font-sans text-ui leading-4.75 text-foreground">
                    {options.body}
                  </DialogDescription>
                ) : null}
                <ConfirmLedger rows={rows} />
              </div>
            ) : null}
          </>
        )}
        {foot}
      </DialogContent>
    </Dialog>
  )
}

/** What is affected: name left, mono meta right, on a rule border. */
function ConfirmLedger({
  rows,
}: {
  rows: NonNullable<ConfirmOptions['rows']>
}) {
  if (rows.length === 0) return null
  return (
    <ul className="flex flex-col border border-rule">
      {rows.map((row, i) => (
        <li
          key={`${row.name}-${i}`}
          className="flex h-[1.625rem] items-center justify-between gap-3 border-b border-rule px-2.5 last:border-b-0"
        >
          <span className="flex min-w-0 items-center gap-2">
            {row.icon}
            <span className="min-w-0 truncate text-label">{row.name}</span>
          </span>
          {row.meta ? (
            <span className="shrink-0 mono text-micro text-graphite">
              {row.meta}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * `const { confirm, confirmDialog } = useConfirm()` — render `confirmDialog`
 * once, then `if (!(await confirm({...}))) return` in place of
 * `window.confirm`. Resolves false on esc, the overlay, and Cancel.
 */
export function useConfirm() {
  const [pending, setPending] = useState<{
    options: ConfirmOptions
    resolve: (ok: boolean) => void
  } | null>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ options, resolve })
      }),
    [],
  )

  function settle(ok: boolean) {
    setPending((p) => {
      p?.resolve(ok)
      return null
    })
  }

  const confirmDialog = pending ? (
    <ConfirmDialog
      open
      options={pending.options}
      onOpenChange={(open) => {
        if (!open) settle(false)
      }}
      onConfirm={() => settle(true)}
    />
  ) : null

  return { confirm, confirmDialog }
}
