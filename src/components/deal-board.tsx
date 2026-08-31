import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { updateRecord } from '#/lib/server-fns'
import { fmtMoney } from '#/lib/portfolio/format'
import { cn } from '#/lib/utils'

/**
 * The pipeline board — one column per stage, native HTML5 drag between
 * columns. A drop is exactly a stage write through updateRecord, so the
 * attribute-event log, the Invested→holding hook, and stage analytics all
 * fire identically to a table edit. No dnd library: cards are links, drags
 * are stage changes, nothing else.
 */

export type BoardDeal = {
  id: string
  name: string
  values: Record<string, unknown>
}

export type BoardStage = {
  id: string
  label: string
  group?: string
  color?: string
}

export function DealBoard({
  deals,
  stages,
  refNames,
  valueCurrency = 'USD',
  medianDaysInStage = {},
}: {
  deals: Array<BoardDeal>
  stages: Array<BoardStage>
  refNames: Record<string, { name: string } | string | undefined>
  /** options.code of the deal value attribute — never hardcode a symbol. */
  valueCurrency?: string
  /** Median days live deals have sat in each stage (funnel stats). */
  medianDaysInStage?: Record<string, number | undefined>
}) {
  const router = useRouter()
  const [dragOver, setDragOver] = useState<string | null>(null)
  // Optimistic column assignment so the card lands before the server does.
  const [moved, setMoved] = useState<Record<string, string>>({})
  // A drop onto Passed/Lost pauses here for the post-mortem reason.
  const [closing, setClosing] = useState<{
    dealId: string
    dealName: string
    stageId: string
    stageLabel: string
  } | null>(null)

  function stageOf(d: BoardDeal): string {
    return moved[d.id] ?? String(d.values.stage ?? '')
  }

  async function commitMove(
    dealId: string,
    stageId: string,
    closeReason?: string,
  ) {
    setMoved((m) => ({ ...m, [dealId]: stageId }))
    try {
      await updateRecord({
        data: {
          id: dealId,
          patch: {
            stage: stageId,
            ...(closeReason ? { close_reason: closeReason } : {}),
          },
        },
      })
      router.invalidate()
    } catch {
      setMoved((m) => {
        const { [dealId]: _, ...rest } = m
        return rest
      })
      toast.error('Could not move the deal')
    }
  }

  function moveTo(dealId: string, stageId: string) {
    const current = deals.find((d) => d.id === dealId)
    if (!current || stageOf(current) === stageId) return
    if (stageId === 'passed' || stageId === 'lost') {
      const stage = stages.find((s) => s.id === stageId)
      setClosing({
        dealId,
        dealName: current.name,
        stageId,
        stageLabel: stage?.label ?? stageId,
      })
      return
    }
    void commitMove(dealId, stageId)
  }

  function companyName(d: BoardDeal): string {
    const id = d.values.company as string | undefined
    if (!id) return ''
    const hit = refNames[id]
    if (!hit) return ''
    return typeof hit === 'string' ? hit : hit.name
  }

  return (
    <>
      {closing ? (
        <CloseReasonDialog
          dealName={closing.dealName}
          stageLabel={closing.stageLabel}
          onCancel={() => setClosing(null)}
          onSave={(reason) => {
            void commitMove(closing.dealId, closing.stageId, reason)
            setClosing(null)
          }}
        />
      ) : null}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const cards = deals.filter((d) => stageOf(d) === stage.id)
          const medianDays = medianDaysInStage[stage.id]
          return (
            <div
              key={stage.id}
              className={cn(
                'flex w-64 shrink-0 flex-col rounded-lg border bg-muted/20 transition-colors duration-150',
                dragOver === stage.id
                  ? 'border-primary/50 bg-selected'
                  : 'border-border',
              )}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(stage.id)
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const id = e.dataTransfer.getData('text/deal-id')
                if (id) moveTo(id, stage.id)
              }}
            >
              <div className="flex items-baseline gap-2 px-3 pt-2.5 pb-1.5">
                <span className="text-label font-semibold">{stage.label}</span>
                <span className="tabular text-label text-muted-foreground">
                  {cards.length}
                </span>
                {cards.length > 0 && medianDays !== undefined ? (
                  <span
                    className="tabular ml-auto text-label text-muted-foreground"
                    title="Median days in this stage"
                  >
                    ~{Math.round(medianDays)}d
                  </span>
                ) : null}
              </div>
              <ol className="min-h-16 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                {cards.map((d) => (
                  <li
                    key={d.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/deal-id', d.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                  >
                    <Link
                      to="/deals/$dealId"
                      params={{ dealId: d.id }}
                      className="block rounded-md border border-border bg-background px-3 py-2 shadow-xs focus-ring transition-colors duration-150 hover:border-input"
                    >
                      <span className="block truncate text-ui font-medium">
                        {d.name}
                      </span>
                      <span className="mt-0.5 flex items-baseline justify-between gap-2">
                        <span className="truncate text-label text-muted-foreground">
                          {companyName(d)}
                        </span>
                        {typeof d.values.value === 'number' ? (
                          <span className="tabular shrink-0 text-label text-muted-foreground">
                            {fmtMoney(d.values.value, valueCurrency, {
                              compact: true,
                            })}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </div>
          )
        })}
      </div>
    </>
  )
}

/**
 * The post-mortem prompt — fired when a deal drops onto Passed or Lost.
 * Skippable on purpose: capture-while-fresh beats forced friction, and the
 * close_reason attribute stays editable on the record afterwards.
 */
export function CloseReasonDialog({
  dealName,
  stageLabel,
  onCancel,
  onSave,
}: {
  dealName: string
  stageLabel: string
  onCancel: () => void
  onSave: (reason?: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {dealName} → {stageLabel}
          </DialogTitle>
          <DialogDescription>
            {stageLabel === 'Passed'
              ? 'Your no. Why? The reason is what future-you rereads.'
              : 'Their no. What happened? Lost deals teach different lessons.'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSave(reason.trim() || undefined)
          }}
        >
          <textarea
            className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-ui focus-ring placeholder:text-muted-foreground"
            placeholder={
              stageLabel === 'Passed'
                ? 'Too early for our check size; team question on GTM…'
                : 'Round was preempted; lost on speed…'
            }
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
          />
          <DialogFooter className="mt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSave(undefined)}
            >
              Skip
            </Button>
            <Button type="submit" size="sm">
              Save reason
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
