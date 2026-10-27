import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Twinkle } from '#/components/twinkle'
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
import { cn } from '#/lib/utils'
import type { Condition } from '@spaces/core/views/filter'

/**
 * Enrich… from a list: a window with the estimate — to ask, then the skips
 * by reason, the split per source on the To ask row's hover — the credits it
 * costs in the foot, and one pine Enrich n. Opening it reads; nothing is
 * queued until the button.
 */

export type EnrichKind = 'company' | 'person'

/** The checked rows, or the list's view for the `···` menu. */
export type BulkTarget =
  | { readonly ids: ReadonlyArray<string> }
  | { readonly conditions: Array<Condition>; readonly q: string }

type Estimate = Awaited<ReturnType<typeof estimateBulkEnrich>>

const n = (v: number) => v.toLocaleString('en-US')

const NOUN: Record<EnrichKind, { one: string; many: string; key: string }> = {
  company: { one: 'company', many: 'companies', key: 'No domain' },
  person: { one: 'person', many: 'people', key: 'No email or LinkedIn' },
}

/** `Already enriched this week`, or the window the reuse skips counted. */
const reuseWords = (days: number): string =>
  days <= 7
    ? 'Already enriched this week'
    : `Already enriched in the last ${n(days)} days`

/** One source's share, for the To ask row's hover. */
const sourceLine = (s: Estimate['sources'][number]): string =>
  [
    `${s.name} ${n(s.ask)}`,
    s.local
      ? 'free'
      : s.left === null
        ? `about ${n(s.credits)} credits`
        : `about ${n(s.credits)} credits of ${n(s.left)} left today`,
  ].join(' · ')

/**
 * The foot's cost over the paid sources that would be asked —
 * `About 34 credits · 100 left today` — and nothing when every one is free.
 */
export function creditNote(e: Estimate): string | null {
  const paid = e.sources.filter((s) => !s.local && s.ask > 0)
  const credits = paid.reduce((sum, s) => sum + s.credits, 0)
  if (credits === 0) return null
  const capped = paid.filter((s) => s.left !== null)
  const left = capped.reduce((sum, s) => sum + (s.left ?? 0), 0)
  return capped.length === 0
    ? `About ${n(credits)} credits`
    : `About ${n(credits)} credits · ${n(left)} left today`
}

type EstimateRow = { id: string; label: string; value: number; tip?: string }

/**
 * To ask, then the skips: sensitive and already enriched always, a missing
 * key and already queued only when they hold something.
 */
function estimateRows(e: Estimate, kind: EnrichKind): Array<EstimateRow> {
  const rows: Array<EstimateRow> = [
    {
      id: 'ask',
      label: 'To ask',
      value: e.ask,
      tip: e.sources.map(sourceLine).join('\n'),
    },
    {
      id: 'sensitive',
      label: 'Skipped, sensitive',
      value: e.skipped.sensitive,
    },
    { id: 'reuse', label: reuseWords(e.reuseDays), value: e.skipped.reuse },
  ]
  if (e.skipped.key > 0)
    rows.push({ id: 'key', label: NOUN[kind].key, value: e.skipped.key })
  if (e.skipped.queued > 0)
    rows.push({
      id: 'queued',
      label: 'Already queued',
      value: e.skipped.queued,
    })
  return rows
}

export function BulkEnrichDialog({
  open,
  onOpenChange,
  kind,
  target,
  onSent,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: EnrichKind
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
          <span data-estimate-scope className="mono text-micro text-graphite">
            {'ids' in target ? 'Selected' : 'This view'}
          </span>
        </DialogHeader>

        {failed !== null ? (
          <p role="alert" className="mono text-label text-destructive">
            {failed}
          </p>
        ) : estimate === null ? (
          <div role="status" className="flex h-24 items-center justify-center">
            <Twinkle />
          </div>
        ) : estimate.sources.length === 0 ? (
          <p className="text-ui text-graphite">
            No enrichment source is on for {noun.many}. Turn one on in Settings
            to enrich them.
          </p>
        ) : (
          <div className="flex flex-col">
            <ul className="flex flex-col border-t border-rule">
              {estimateRows(estimate, kind).map((r) => (
                <li
                  key={r.id}
                  data-estimate-row={r.id}
                  {...(r.tip === undefined ? {} : { title: r.tip })}
                  className="flex h-9 items-center justify-between gap-4 border-b border-rule"
                >
                  <span className="text-ui">{r.label}</span>
                  <span
                    className={cn(
                      'numeric mono text-ui',
                      r.value === 0 && 'text-graphite',
                    )}
                  >
                    {n(r.value)}
                  </span>
                </li>
              ))}
            </ul>
            {!('ids' in target) && estimate.matched > estimate.total ? (
              <p className="mt-2 mono text-micro text-graphite">
                The first {n(estimate.total)} of {n(estimate.matched)} in this
                view
              </p>
            ) : null}
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

        <DialogFooter note={estimate === null ? null : creditNote(estimate)}>
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
