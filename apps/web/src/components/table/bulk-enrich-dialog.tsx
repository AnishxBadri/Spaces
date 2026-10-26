import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { BULK_SKIPS, skippedTotal } from '@spaces/core/enrichment/estimate'
import type { BulkSkip, SkipCounts } from '@spaces/core/enrichment/estimate'
import { DensityRamp } from '#/components/dither'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { bulkEnrich, estimateBulkEnrich } from '#/lib/server-fns'
import type { Condition } from '@spaces/core/views/filter'
import { ListMenu } from './list-menu'
import type { ListVerb } from './list-menu'
import type { TableSelect } from './record-table'
import { SelectionBar, useRowSelection } from './selection-bar'

/**
 * Enrich… from a list: a window with the estimate per source — to ask,
 * skipped by reason, credits against what is left today — and one pine
 * Enrich n. Opening it reads; nothing is queued until the button.
 */

type Kind = 'company' | 'person'

/** The checked rows, or the list's view for the `···` menu. */
export type BulkTarget =
  | { readonly ids: ReadonlyArray<string> }
  | { readonly conditions: Array<Condition>; readonly q: string }

type Estimate = Awaited<ReturnType<typeof estimateBulkEnrich>>

const n = (v: number) => v.toLocaleString('en-US')

const NOUN: Record<Kind, { one: string; many: string; key: string }> = {
  company: { one: 'company', many: 'companies', key: 'no domain' },
  person: { one: 'person', many: 'people', key: 'no email or LinkedIn' },
}

const skipWords = (
  kind: Kind,
  reuseDays: number,
): Record<BulkSkip, string> => ({
  sensitive: 'sensitive',
  reuse: `enriched in the last ${n(reuseDays)} days`,
  key: NOUN[kind].key,
  queued: 'already queued',
})

/** `2 sensitive · 1 no domain` — the nonzero reasons, in check order. */
const skipLine = (
  counts: SkipCounts,
  words: Record<BulkSkip, string>,
): string =>
  BULK_SKIPS.filter((k) => counts[k] > 0)
    .map((k) => `${n(counts[k])} ${words[k]}`)
    .join(' · ')

const creditWords = (s: Estimate['sources'][number]): string =>
  s.local
    ? 'free'
    : s.left === null
      ? `about ${n(s.credits)} credits · no daily cap`
      : `about ${n(s.credits)} credits of ${n(s.left)} left today`

/** `34 to ask · 6 skipped · about 34 Apollo credits of 100 left today` */
const summaryLine = (e: Estimate): string =>
  [
    `${n(e.ask)} to ask`,
    `${n(skippedTotal(e.skipped))} skipped`,
    ...e.sources
      .filter((s) => !s.local && s.ask > 0)
      .map((s) =>
        s.left === null
          ? `about ${n(s.credits)} ${s.name} credits`
          : `about ${n(s.credits)} ${s.name} credits of ${n(s.left)} left today`,
      ),
  ].join(' · ')

export function BulkEnrichDialog({
  open,
  onOpenChange,
  kind,
  target,
  onSent,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: Kind
  target: BulkTarget
  /** After Enrich n has queued: the list clears and refreshes. */
  onSent: () => void
}) {
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const noun = NOUN[kind]

  const data = {
    kind,
    target:
      'ids' in target
        ? { ids: [...target.ids] }
        : { conditions: target.conditions, q: target.q },
  }
  const key = JSON.stringify(data)

  useEffect(() => {
    if (!open) return
    let live = true
    setEstimate(null)
    setFailed(null)
    estimateBulkEnrich({ data })
      .then((e) => {
        if (live) setEstimate(e)
      })
      .catch((err: unknown) => {
        if (live)
          setFailed(
            err instanceof Error ? err.message : 'Could not read the estimate',
          )
      })
    return () => {
      live = false
    }
    // `key` is `data` spelled as a value: a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key])

  async function confirm() {
    if (estimate === null || estimate.ask === 0 || busy) return
    setBusy(true)
    try {
      const out = await bulkEnrich({ data })
      toast(
        [
          `${n(out.queued)} queued`,
          ...(out.parked > 0 ? [`${n(out.parked)} park until 00:00 UTC`] : []),
          ...(out.already > 0 ? [`${n(out.already)} already waiting`] : []),
        ].join(' · '),
      )
      onOpenChange(false)
      onSent()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not enrich')
    } finally {
      setBusy(false)
    }
  }

  const count = estimate?.total ?? ('ids' in target ? target.ids.length : null)
  const words = skipWords(kind, estimate?.reuseDays ?? 0)
  const parkedBy = estimate?.sources.filter((s) => s.parks > 0) ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="m"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void confirm()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            Enrich
            {count === null
              ? ' this view'
              : ` ${n(count)} ${count === 1 ? noun.one : noun.many}`}
          </DialogTitle>
          <span className="mono text-micro text-graphite">estimate</span>
        </DialogHeader>

        {failed !== null ? (
          <p role="alert" className="mono text-label text-destructive">
            {failed}
          </p>
        ) : estimate === null ? (
          <div className="flex h-24 items-center justify-center">
            <DensityRamp />
          </div>
        ) : estimate.sources.length === 0 ? (
          <p className="text-ui text-graphite">
            No enrichment source is on for {noun.many}. Turn one on in Settings
            to enrich them.
          </p>
        ) : (
          <div className="flex flex-col">
            <p data-estimate-summary className="mono text-label">
              {summaryLine(estimate)}
            </p>
            {!('ids' in target) && estimate.matched > estimate.total ? (
              <p className="mt-1 mono text-micro text-graphite">
                the first {n(estimate.total)} of {n(estimate.matched)} in this
                view
              </p>
            ) : null}
            <ul className="mt-4 flex flex-col border-t border-rule">
              {estimate.sources.map((s) => {
                const skips = skipLine(s.skipped, words)
                return (
                  <li
                    key={s.id}
                    className="flex min-h-11 items-center gap-4 border-b border-rule py-1.5"
                  >
                    <span className="w-24 shrink-0 truncate text-ui font-medium">
                      {s.name}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="mono text-label">{n(s.ask)} to ask</span>
                      {skips ? (
                        <span className="mono text-micro text-graphite">
                          skipped · {skips}
                        </span>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-right mono text-label text-graphite">
                      {creditWords(s)}
                    </span>
                  </li>
                )
              })}
            </ul>
            {parkedBy.map((s) => (
              <p
                key={s.id}
                data-estimate-parks
                className="mt-3 mono text-label text-warning"
              >
                {n(s.parks)} park until 00:00 UTC · {s.name}’s daily cap
              </p>
            ))}
          </div>
        )}

        <DialogFooter note="Nothing is spent until Enrich.">
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            shortcut="⌘↵"
            disabled={estimate === null || estimate.ask === 0 || busy}
            onClick={() => void confirm()}
          >
            Enrich {estimate === null ? '' : n(estimate.ask)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Seconds after Enrich n at which the list re-reads, while the runs land. */
const FILL_AT = [10, 25, 45, 70]

/**
 * Enrich… on a record list: the row checkboxes, the selection bar with
 * Enrich… as its pine verb, the head's Enrich… over the view — as `verb`
 * for a `ListMenu` that holds others, or `menu` on its own — and the window
 * either opens.
 */
export function useListEnrich<T extends { id: string; name: string }>({
  kind,
  label,
  rows,
  view,
  refresh,
}: {
  kind: Kind
  /** The list's name — "Companies". */
  label: string
  /** The loaded rows. */
  rows: ReadonlyArray<T>
  /** The view as the list shows it: what the `···` Enrich… runs over. */
  view: { conditions: Array<Condition>; q: string }
  refresh: () => void
}): {
  select: TableSelect<T>
  selectionBar: ReactNode
  verb: ListVerb
  menu: ReactNode
  dialog: ReactNode
} {
  const selection = useRowSelection()
  const [target, setTarget] = useState<BulkTarget | null>(null)
  const chosen = selection.among(rows.map((r) => r.id))
  const timers = useRef<Array<number>>([])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending) window.clearTimeout(t)
    }
  }, [])

  function sent() {
    selection.clear()
    refresh()
    for (const s of FILL_AT)
      timers.current.push(window.setTimeout(refresh, s * 1000))
  }

  const verb: ListVerb = { label: 'Enrich…', onSelect: () => setTarget(view) }
  return {
    select: { rows: selection, keyOf: (r) => r.id, nameOf: (r) => r.name },
    selectionBar:
      chosen.length > 0 ? (
        <SelectionBar
          label={`Selected ${label.toLowerCase()}`}
          count={chosen.length}
        >
          <span className="flex-1" />
          <button
            type="button"
            onClick={selection.clear}
            className="focus-ring mono text-label text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground"
          >
            clear
          </button>
          <Button size="sm" onClick={() => setTarget({ ids: chosen })}>
            Enrich…
          </Button>
        </SelectionBar>
      ) : null,
    verb,
    menu: <ListMenu label={label} verbs={[verb]} />,
    dialog:
      target === null ? null : (
        <BulkEnrichDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null)
          }}
          kind={kind}
          target={target}
          onSent={sent}
        />
      ),
  }
}
