import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
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
}: {
  deals: Array<BoardDeal>
  stages: Array<BoardStage>
  refNames: Record<string, { name: string } | string | undefined>
  /** options.code of the deal value attribute — never hardcode a symbol. */
  valueCurrency?: string
}) {
  const router = useRouter()
  const [dragOver, setDragOver] = useState<string | null>(null)
  // Optimistic column assignment so the card lands before the server does.
  const [moved, setMoved] = useState<Record<string, string>>({})

  function stageOf(d: BoardDeal): string {
    return moved[d.id] ?? String(d.values.stage ?? '')
  }

  async function moveTo(dealId: string, stageId: string) {
    const current = deals.find((d) => d.id === dealId)
    if (!current || stageOf(current) === stageId) return
    setMoved((m) => ({ ...m, [dealId]: stageId }))
    try {
      await updateRecord({ data: { id: dealId, patch: { stage: stageId } } })
      router.invalidate()
    } catch {
      setMoved((m) => {
        const { [dealId]: _, ...rest } = m
        return rest
      })
      toast.error('Could not move the deal')
    }
  }

  function companyName(d: BoardDeal): string {
    const id = d.values.company as string | undefined
    if (!id) return ''
    const hit = refNames[id]
    if (!hit) return ''
    return typeof hit === 'string' ? hit : hit.name
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-4">
      {stages.map((stage) => {
        const cards = deals.filter((d) => stageOf(d) === stage.id)
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
                    className="focus-ring block rounded-md border border-border bg-background px-3 py-2 shadow-xs transition-colors duration-150 hover:border-input"
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
  )
}
