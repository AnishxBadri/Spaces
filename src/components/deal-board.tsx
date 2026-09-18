import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { KeyHint } from './page-header'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { DitherMark, InitialsMark } from './record/record-parts'
import { badgeStyle, optionColor } from '#/lib/attributes/colors'
import { updateRecord } from '#/lib/server-fns'
import { fmtMoney } from '#/lib/portfolio/format'
import { localToday } from '#/lib/tasks/parse-due'
import { cn } from '#/lib/utils'

/** Cards shown per column before the dashed "+N more" row. */
const COLUMN_LIMIT = 8

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
  /** retired stage: shown greyed while deals remain, gone once emptied */
  archived?: boolean
}

export function DealBoard({
  deals,
  stages,
  refNames,
  valueCurrency = 'USD',
  medianDaysInStage = {},
  daysInStage = {},
}: {
  deals: Array<BoardDeal>
  stages: Array<BoardStage>
  refNames: Record<string, { name: string } | string | undefined>
  /** options.code of the deal value attribute — never hardcode a symbol. */
  valueCurrency?: string
  /** Median days live deals have sat in each stage (funnel stats). */
  medianDaysInStage?: Record<string, number | undefined>
  /** Days each deal has sat in its current stage, by deal id (funnel stats). */
  daysInStage?: Record<string, number | null | undefined>
}) {
  const router = useRouter()
  const today = localToday()
  const [dragOver, setDragOver] = useState<string | null>(null)
  // Columns fold past COLUMN_LIMIT; the dashed row opens them.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
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
      void router.invalidate()
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

  function nameOf(id: unknown): string {
    if (typeof id !== 'string' || !id) return ''
    const hit = refNames[id]
    if (!hit) return ''
    return typeof hit === 'string' ? hit : hit.name
  }

  function daysUntil(iso: string): number {
    return Math.round(
      (new Date(`${iso}T00:00:00Z`).getTime() -
        new Date(`${today}T00:00:00Z`).getTime()) /
        86_400_000,
    )
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
        {stages.map((stage, stageIndex) => {
          const cards = deals.filter((d) => stageOf(d) === stage.id)
          const medianDays = medianDaysInStage[stage.id]
          // An archived stage is history: it stays on the board only while
          // deals still sit in it (spec §3), and nothing can be dropped into
          // it — the write would be rejected anyway, so the drop is not
          // offered. Cards can still be dragged out; that's the cleanup.
          if (stage.archived && cards.length === 0) return null
          const droppable = !stage.archived
          const shown = expanded[stage.id]
            ? cards
            : cards.slice(0, COLUMN_LIMIT)
          const sum = cards.reduce(
            (acc, d) =>
              acc + (typeof d.values.value === 'number' ? d.values.value : 0),
            0,
          )
          return (
            <div
              key={stage.id}
              className="flex w-56 shrink-0 flex-col gap-2"
              onDragOver={(e) => {
                if (!droppable) {
                  e.dataTransfer.dropEffect = 'none'
                  return
                }
                e.preventDefault()
                setDragOver(stage.id)
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                if (!droppable) return
                e.preventDefault()
                setDragOver(null)
                const id = e.dataTransfer.getData('text/deal-id')
                if (id) moveTo(id, stage.id)
              }}
            >
              {/* The column head is a mini readout strip: badge, count, Σ,
                  median — hairline under. */}
              <div
                className="flex flex-col gap-1 border-b border-hairline pb-2"
                title={stage.archived ? 'Archived stage' : undefined}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      'flex h-[1.125rem] min-w-0 items-center truncate px-1.5 mono text-micro font-medium',
                      stage.archived && 'bg-bone-deep text-graphite',
                    )}
                    style={
                      stage.archived
                        ? undefined
                        : badgeStyle(optionColor(stage, stageIndex))
                    }
                  >
                    {stage.label}
                    {stage.archived ? ' · archived' : ''}
                  </span>
                  <span className="mono text-micro text-foreground">
                    {cards.length}
                  </span>
                </div>
                <div className="flex justify-between gap-2 mono text-field text-graphite">
                  <span>
                    Σ{' '}
                    {sum > 0
                      ? fmtMoney(sum, valueCurrency, { compact: true })
                      : '—'}
                  </span>
                  <span>
                    {cards.length > 0 && medianDays !== undefined
                      ? `med ${Math.round(medianDays)}d`
                      : ''}
                  </span>
                </div>
              </div>
              <ol className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto">
                {shown.map((d) => {
                  const days = daysInStage[d.id]
                  const late =
                    days !== null &&
                    days !== undefined &&
                    medianDays !== undefined &&
                    medianDays > 0 &&
                    days > 2 * medianDays
                  const close =
                    typeof d.values.close_date === 'string'
                      ? d.values.close_date
                      : null
                  const owner = nameOf(d.values.owner)
                  const company = nameOf(d.values.company)
                  return (
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
                        className="focus-ring flex flex-col gap-2 rounded-md border border-rule bg-paper p-2.5 transition-colors duration-150 hover:border-hairline"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <DitherMark size={14} />
                          <span className="truncate text-ui leading-4 font-medium">
                            {d.name}
                          </span>
                        </span>
                        <span className="flex items-baseline justify-between gap-2 mono text-micro">
                          <span className="min-w-0 truncate text-graphite">
                            {[
                              company,
                              typeof d.values.value === 'number'
                                ? fmtMoney(d.values.value, valueCurrency, {
                                    compact: true,
                                  })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                          </span>
                          {days !== null && days !== undefined ? (
                            <span
                              className={cn(
                                'shrink-0',
                                late ? 'text-destructive' : 'text-foreground',
                              )}
                            >
                              {Math.round(days)}d
                            </span>
                          ) : null}
                        </span>
                        <span className="flex items-center justify-between gap-2 mono text-field text-graphite">
                          <span className="truncate">
                            {close
                              ? `close ${close.slice(5)} · ${daysUntil(close) < 0 ? '−' : ''}${Math.abs(daysUntil(close))}d`
                              : 'close —'}
                          </span>
                          {owner ? (
                            <InitialsMark name={owner} size="xs" />
                          ) : null}
                        </span>
                      </Link>
                    </li>
                  )
                })}
                {cards.length > shown.length ? (
                  <li>
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((m) => ({ ...m, [stage.id]: true }))
                      }
                      className="focus-ring flex h-7 w-full items-center border border-dashed border-rule px-2.5 mono text-micro text-graphite transition-colors hover:border-hairline hover:text-foreground"
                    >
                      + {cards.length - shown.length} more
                    </button>
                  </li>
                ) : null}
                {dragOver === stage.id ? (
                  <li
                    aria-hidden
                    className="flex h-18 items-center justify-center border border-dashed border-primary bg-selected mono text-micro text-primary"
                  >
                    drop → {stage.label}
                  </li>
                ) : null}
              </ol>
            </div>
          )
        })}
      </div>
    </>
  )
}

/**
 * Move stage (Overlays sheet): every live stage as a numbered row — square
 * badge, a mono note (current · days, → next, asks for a reason), the digit
 * that picks it. Digits pick, ↵ confirms; Passed and Lost open the reason
 * field, which lands on the record as close_reason. The picked row is the
 * selection wash, the current one bone — never a pine bar.
 */
export function MoveStageDialog({
  dealName,
  stages,
  currentId,
  daysInStage,
  onCancel,
  onMove,
}: {
  dealName: string
  stages: Array<BoardStage>
  currentId: string | null
  daysInStage?: number | null
  onCancel: () => void
  onMove: (stageId: string, reason?: string) => void
}) {
  const currentIndex = stages.findIndex((s) => s.id === currentId)
  const [picked, setPicked] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const pickedStage = stages.find((s) => s.id === picked) ?? null
  const asksReason = picked === 'passed' || picked === 'lost'
  const canMove = pickedStage !== null && picked !== currentId

  function confirm() {
    if (!pickedStage || !canMove) return
    onMove(pickedStage.id, asksReason ? reason.trim() : '')
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a document-level keydown's target is EventTarget; the hotkey guard needs tagName
      const t = e.target as HTMLElement | null
      const typing = t && ['INPUT', 'TEXTAREA'].includes(t.tagName)
      if (e.key === 'Enter' && !typing) {
        e.preventDefault()
        confirm()
        return
      }
      if (typing) return
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= stages.length) {
        e.preventDefault()
        setPicked(stages[n - 1].id)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>Move stage</DialogTitle>
          <DialogDescription>{dealName}</DialogDescription>
        </DialogHeader>
        <ol className="-mx-3 -mt-3 flex flex-col">
          {stages.map((stage, i) => {
            const isCurrent = stage.id === currentId
            const isNext = i === currentIndex + 1
            const isPicked = stage.id === picked
            return (
              <li key={stage.id}>
                <button
                  type="button"
                  onClick={() => setPicked(stage.id)}
                  aria-pressed={isPicked}
                  className={cn(
                    'focus-ring-inset flex h-8 w-full items-center justify-between gap-3 px-3 text-left transition-colors',
                    isPicked
                      ? 'bg-selected'
                      : isCurrent
                        ? 'bg-bone'
                        : 'hover:bg-bone',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="flex h-5 shrink-0 items-center px-1.5 mono text-micro font-medium"
                      style={badgeStyle(optionColor(stage, i))}
                    >
                      {stage.label}
                    </span>
                    <span
                      className={cn(
                        'truncate mono text-micro',
                        isNext ? 'text-primary' : 'text-graphite',
                        isCurrent && 'text-foreground',
                      )}
                    >
                      {isCurrent
                        ? daysInStage === null || daysInStage === undefined
                          ? 'current'
                          : `current · ${daysInStage}d`
                        : isNext
                          ? '→ next'
                          : stage.id === 'passed' || stage.id === 'lost'
                            ? 'asks for a reason'
                            : ''}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'mono text-micro',
                      isPicked ? 'text-foreground' : 'text-graphite',
                    )}
                  >
                    {i + 1}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        {asksReason ? (
          <div className="mt-3 flex flex-col gap-1.5 border-t border-rule pt-3">
            <span className="field-label text-graphite">
              Reason · goes to the ledger
            </span>
            <textarea
              className="focus-ring min-h-14 w-full rounded-md border border-rule bg-transparent px-2.5 py-2 font-serif text-title leading-5.75 placeholder:text-graphite"
              placeholder={
                picked === 'passed'
                  ? 'Too early for our check size; team question on GTM…'
                  : 'Round was preempted; lost on speed…'
              }
              value={reason}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  confirm()
                }
              }}
            />
          </div>
        ) : null}
        <DialogFooter note={`1–${stages.length} pick · ↵ confirm`}>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={!canMove} onClick={confirm}>
            {pickedStage ? `Move to ${pickedStage.label}` : 'Move'}
            <KeyHint>↵</KeyHint>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
            onSave(reason.trim())
          }}
        >
          <textarea
            className="focus-ring min-h-24 w-full rounded-md border border-rule bg-transparent px-3 py-2 text-ui placeholder:text-graphite"
            placeholder={
              stageLabel === 'Passed'
                ? 'Too early for our check size; team question on GTM…'
                : 'Round was preempted; lost on speed…'
            }
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits — Enter alone stays a newline.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                onSave(reason.trim())
              }
            }}
          />
          <DialogFooter note="goes to the ledger as close reason">
            <Button
              type="button"
              variant="outline"
              onClick={() => onSave(undefined)}
            >
              Skip
            </Button>
            <Button type="submit">
              Save reason
              <KeyHint>⌘↵</KeyHint>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
