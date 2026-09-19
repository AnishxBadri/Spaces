import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'

import { Button } from '#/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '#/components/ui/dialog.tsx'
import { cn } from '#/lib/utils.ts'

export type ConfirmOptions = {
  /** Serif question: "Delete pitch.pdf?" */
  title: string
  /** One sans sentence saying what happens, and what does not. */
  body?: ReactNode
  /** The things affected — name left, mono meta right — when there are several. */
  rows?: Array<{ name: string; meta?: string }>
  /**
   * The verb on the acting button: "Delete", "Archive 3". Omitted, the sheet
   * is a notice — one way out and no button that promises something the
   * server has already refused (SPA-125: the mandate's note).
   */
  action?: string
  /** The safe way out. */
  keep?: string
  /** Destructive is the default — that is what confirms are for. */
  kind?: 'destructive' | 'primary'
}

/**
 * The destructive confirm (Overlays sheet, "Confirm — destructive"): a 440px
 * paper sheet with no title bar — a crimson square beside the serif question,
 * one sentence, an optional ledger of what is affected on a rule border, then
 * the 52px bone foot: Keep, and the acting button carrying ⌘↵. Focus lands on
 * Keep; the destructive choice is one key further away.
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[27.5rem]"
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
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className={cn(
                'size-2 shrink-0',
                kind === 'destructive' ? 'bg-destructive' : 'bg-primary',
              )}
            />
            <DialogTitle>{options.title}</DialogTitle>
          </div>
          {options.body ? (
            <DialogDescription className="font-sans text-ui leading-4.75 text-foreground">
              {options.body}
            </DialogDescription>
          ) : null}
          {options.rows && options.rows.length > 0 ? (
            <ul className="flex flex-col border border-rule">
              {options.rows.map((row, i) => (
                <li
                  key={`${row.name}-${i}`}
                  className="flex h-[1.625rem] items-center justify-between gap-3 border-b border-rule px-2.5 last:border-b-0"
                >
                  <span className="min-w-0 truncate text-label">
                    {row.name}
                  </span>
                  {row.meta ? (
                    <span className="shrink-0 mono text-micro text-graphite">
                      {row.meta}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter className="border-rule">
          <DialogClose asChild>
            <Button variant="outline">{options.keep ?? 'Keep'}</Button>
          </DialogClose>
          {options.action === undefined ? null : (
            <Button
              variant={kind === 'destructive' ? 'destructive' : 'default'}
              onClick={onConfirm}
            >
              {options.action}
              <kbd className="mono text-micro opacity-85">⌘↵</kbd>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * `const { confirm, confirmDialog } = useConfirm()` — render `confirmDialog`
 * once, then `if (!(await confirm({...}))) return` where `window.confirm`
 * used to be. Resolves false on esc, the overlay, and Keep.
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
