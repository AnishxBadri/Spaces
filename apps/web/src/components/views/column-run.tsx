import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { readAiConfig } from '@spaces/core/ai/attribute-ai'
import { formatNumber } from '@spaces/core/format'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import type { ColumnAction } from '#/components/table/record-table'
import { ConfirmDialog } from '#/components/ui/confirm-dialog'
import type { ConfirmOptions } from '#/components/ui/confirm-dialog'
import { estimateColumnRun, runColumn } from '#/lib/server-fns'
import type { ColumnRunEstimate } from '#/lib/server-fns'

/**
 * "Run on this view" (SPA-122, spec-ai-substrate §13 "bulk = job with
 * estimate + per-day cap") — the column header's verb on an attribute that
 * carries `options.ai`, over the saved view the list is showing. Nothing
 * runs on the press: the confirm opens with the **estimate** — the view's
 * records counted in SQL over its saved conditions, minus the ones already
 * proposed, and the rough token cost of the last run — and only its button
 * queues the job. A view the compiler cannot express says why and offers no
 * button. No AI config, or no saved view selected → no verb at all.
 *
 * The list routes hold one of these: `columnActions` goes to `RecordTable`,
 * `dialog` renders beside it (a dropdown closes on select, so the confirm
 * lives outside the menu).
 */

type Pending = {
  attributeId: string
  attributeName: string
  estimate: ColumnRunEstimate | null
}

const count = (n: number) => formatNumber(n, 0)

/** What the confirm says, for the estimate as it stands. Pure. */
export function columnRunConfirm(
  attributeName: string,
  estimate: ColumnRunEstimate | null,
): ConfirmOptions {
  if (estimate === null)
    return {
      title: `Run ${attributeName} on this view?`,
      body: 'Counting the view’s records…',
      keep: 'Cancel',
      kind: 'primary',
    }
  if (!estimate.ok)
    return {
      title: `${attributeName} can’t run on this view`,
      body: estimate.reason,
      keep: 'Close',
      kind: 'primary',
    }
  const rows: NonNullable<ConfirmOptions['rows']> = [
    { name: 'Records in this view', meta: count(estimate.total) },
    { name: 'Already proposed', meta: count(estimate.proposed) },
    { name: 'Calls', meta: `~${count(estimate.calls)}` },
    {
      name: 'Tokens, roughly',
      meta:
        estimate.tokens === null || estimate.perCall === null
          ? 'unknown'
          : `~${count(estimate.tokens)} · ${estimate.perCall.from === 'attribute' ? 'from its last run' : 'from the lane’s last call'}`,
    },
  ]
  if (estimate.calls === 0)
    return {
      title: `Nothing to run on “${estimate.viewName}”`,
      body:
        estimate.total === 0
          ? 'The view holds no records.'
          : `Every record in the view already has a ${estimate.attributeName} proposal waiting in the inbox.`,
      rows,
      keep: 'Close',
      kind: 'primary',
    }
  return {
    title: `Run ${estimate.attributeName} on “${estimate.viewName}”?`,
    body: `One call per record the saved view holds without a proposal. Each answer lands in the inbox as a suggestion under one header; nothing is written until it is accepted. The run stops at today’s AI cap.`,
    rows,
    action: `Run ${count(estimate.calls)}`,
    keep: 'Cancel',
    kind: 'primary',
  }
}

export function useColumnRun({
  viewId,
  registry,
}: {
  /** The saved view the list is showing; null on "all records". */
  viewId: string | null
  registry: ReadonlyArray<RegistryEntry>
}): {
  columnActions: (columnId: string) => ReadonlyArray<ColumnAction>
  dialog: ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)

  const open = useCallback(
    (attributeId: string, attributeName: string, view: string) => {
      setPending({ attributeId, attributeName, estimate: null })
      estimateColumnRun({ data: { viewId: view, attributeId } })
        .then((estimate) =>
          setPending((p) =>
            p?.attributeId === attributeId ? { ...p, estimate } : p,
          ),
        )
        .catch((err: unknown) =>
          setPending((p) =>
            p?.attributeId === attributeId
              ? {
                  ...p,
                  estimate: {
                    ok: false,
                    reason:
                      err instanceof Error && err.message !== ''
                        ? err.message
                        : 'Could not count the view’s records',
                  },
                }
              : p,
          ),
        )
    },
    [],
  )

  const columnActions = useCallback(
    (columnId: string): ReadonlyArray<ColumnAction> => {
      if (viewId === null || !columnId.startsWith('attr:')) return []
      const def = registry.find((d) => `attr:${d.slug}` === columnId)
      if (!def || def.id === undefined || readAiConfig(def) === null) return []
      const attributeId = def.id
      return [
        {
          label: 'Run on this view',
          onSelect: () => open(attributeId, def.name, viewId),
        },
      ]
    },
    [viewId, registry, open],
  )

  async function confirm(p: Pending) {
    if (viewId === null) return
    setPending(null)
    try {
      const r = await runColumn({
        data: { viewId, attributeId: p.attributeId },
      })
      switch (r.status) {
        case 'queued':
          toast(`Column run queued: ${count(r.calls)} records`, {
            description: 'Suggestions arrive in the inbox under one header.',
          })
          break
        case 'already-running':
          toast('That column run is already queued or running')
          break
        case 'queue-unavailable':
          toast.error('The job queue is unavailable; nothing was queued')
          break
        case 'refused':
          toast.error(r.message)
          break
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not queue the run',
      )
    }
  }

  const dialog =
    pending === null ? null : (
      <ConfirmDialog
        open
        onOpenChange={(o) => {
          if (!o) setPending(null)
        }}
        options={columnRunConfirm(pending.attributeName, pending.estimate)}
        onConfirm={() => void confirm(pending)}
      />
    )

  return { columnActions, dialog }
}
