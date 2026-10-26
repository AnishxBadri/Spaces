import { ClientOnly, createFileRoute, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  deriveMarkdown,
  extractMentionIds,
  NoteEditor,
} from '#/components/editor/note-editor'
import { EmptyState } from '#/components/empty-state'
import { NOTE_INSET } from '#/components/editor/note-column'
import { PageHeader } from '#/components/page-header'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  createMandate,
  getMandate,
  getNote,
  listRegistry,
  saveNote,
  updateMandateFacts,
} from '#/lib/server-fns'
import { formatDay, formatNumber, formatTime } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'
import type { NoteBody } from '@spaces/db/schema/kinds'

/**
 * The Mandate — the fund's one "why we invest" destination. A facts grid
 * (stages, geographies, check size) on rules under the header, then the
 * prose strategy as a real note in the serif register. Facts mostly
 * display; the one live consumer is the outside-mandate hint on deals.
 */
export const Route = createFileRoute('/_app/mandate')({
  loader: async () => {
    const [m, registry] = await Promise.all([
      getMandate(),
      listRegistry({ data: { kind: 'company' } }),
    ])
    const stageAttr = registry.find((a) => a.slug === 'funding_stage')
    const stageOptions = stageAttr?.options.options ?? []
    if (!m) return { mandate: null, note: null, stageOptions }
    const note = await getNote({ data: { id: m.noteEntityId } })
    return { mandate: m, note, stageOptions }
  },
  component: MandatePage,
})

type StageOption = {
  id: string
  label: string
  color?: string
  archived?: boolean
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved'

function MandatePage() {
  const { mandate, note, stageOptions } = Route.useLoaderData()
  const router = useRouter()
  const { now } = useClock()
  const [creating, setCreating] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [savedAt, setSavedAt] = useState<string | null>(null)

  if (!mandate) {
    return (
      <div className="flex min-h-full flex-col">
        <PageHeader title="Mandate" description={<span>Not written</span>} />
        <EmptyState
          title="State your mandate"
          body="Where you invest, at what stage, at what check size, and why. Deals outside it get a quiet flag, never a block — edge cases are the job."
          action={
            <Button
              disabled={creating}
              onClick={async () => {
                setCreating(true)
                try {
                  await createMandate()
                  void router.invalidate()
                } catch {
                  toast.error('Could not create the mandate')
                  setCreating(false)
                }
              }}
            >
              {creating ? 'Creating…' : 'Write the mandate'}
            </Button>
          }
        />
      </div>
    )
  }

  const activeStages = mandate.stages.length
  const status =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'dirty'
        ? 'Unsaved'
        : saveState === 'saved' && savedAt
          ? `Saved ${savedAt}`
          : ''

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Mandate"
        description={
          <span data-mandate-meta>
            Updated {formatDay(note.updatedAt, now)} · {activeStages} stage
            {activeStages === 1 ? '' : 's'} · {mandate.geos.length} geo
            {mandate.geos.length === 1 ? '' : 's'}
          </span>
        }
        action={
          <span
            data-save-state
            className="mono text-micro text-graphite"
            role="status"
            aria-live="polite"
          >
            {status}
          </span>
        }
      />

      <FactsGrid mandate={mandate} stageOptions={stageOptions} />

      {/* The facts and the prose wear the note inset, so they keep one
          edge; the head keeps the page's px-8 like every other page. */}
      <div className={cn('pt-6 pr-8 pb-8', NOTE_INSET)}>
        <MandateProse
          noteId={note.id}
          note={note}
          onState={(s) => {
            setSaveState(s)
            if (s === 'saved') setSavedAt(formatTime(new Date()))
          }}
        />
      </div>
    </div>
  )
}

// ---------- facts grid ----------

type Mandate = NonNullable<Awaited<ReturnType<typeof getMandate>>>

/** One row of the grid: a 96px sans label, values, a mono note on the
 *  right. */
function FactRow({
  label,
  note,
  last,
  children,
}: {
  label: string
  note?: string
  last?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex min-h-11 items-center gap-3 py-2',
        !last && 'border-b border-rule',
      )}
    >
      <div className="w-24 shrink-0 text-label text-graphite">{label}</div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {children}
      </div>
      {note ? (
        <div className="shrink-0 mono text-micro text-graphite max-md:hidden">
          {note}
        </div>
      ) : null}
    </div>
  )
}

function FactsGrid({
  mandate,
  stageOptions,
}: {
  mandate: Mandate
  stageOptions: Array<StageOption>
}) {
  const router = useRouter()

  async function save(patch: Parameters<typeof updateMandateFacts>[0]['data']) {
    try {
      await updateMandateFacts({ data: patch })
      void router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    }
  }

  // Archived stages leave the picker (writes never assert them)
  // but a mandate that already names one keeps it, greyed.
  const stages = stageOptions.filter(
    (opt) => !opt.archived || mandate.stages.includes(opt.id),
  )

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col border-b border-hairline pr-8',
        NOTE_INSET,
      )}
    >
      <FactRow
        label="Stages"
        note={`${mandate.stages.length} of ${stages.length}`}
      >
        {stages.map((opt) => {
          const active = mandate.stages.includes(opt.id)
          return (
            // Chosen stages wear their tint; the rest sit on bone.
            <Badge
              key={opt.id}
              asChild
              option={opt}
              index={0}
              unselected={!active}
              className={
                active ? undefined : 'border-solid border-transparent bg-bone'
              }
            >
              <button
                type="button"
                aria-pressed={active}
                onClick={() =>
                  save({
                    stages: active
                      ? mandate.stages.filter((s) => s !== opt.id)
                      : [...mandate.stages, opt.id],
                  })
                }
              >
                {opt.label}
              </button>
            </Badge>
          )
        })}
      </FactRow>

      <FactRow label="Geographies">
        <GeoChips geos={mandate.geos} onSave={(geos) => save({ geos })} />
      </FactRow>

      <FactRow label="Check size" last>
        <CheckSizeInputs
          checkMin={mandate.checkMin}
          checkMax={mandate.checkMax}
          currency={mandate.currency}
          onSave={(patch) => save(patch)}
        />
      </FactRow>
    </div>
  )
}

/**
 * The geographies as `India ×` chips, then an inline field and a pine `+`
 * that add one; ↵ adds too. A name already there (any case) is not added
 * twice.
 */
function GeoChips({
  geos,
  onSave,
}: {
  geos: Array<string>
  onSave: (geos: Array<string>) => void
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const v = draft.trim()
    setDraft('')
    if (!v) return
    if (geos.some((g) => g.toLowerCase() === v.toLowerCase())) return
    onSave([...geos, v])
  }

  return (
    <>
      {geos.map((g) => (
        <span
          key={g}
          data-geo-chip
          className="flex h-5.5 items-center gap-2 border border-rule bg-paper px-2 text-label font-medium"
        >
          {g}
          <button
            type="button"
            aria-label={`Remove ${g}`}
            onClick={() => onSave(geos.filter((x) => x !== g))}
            className="focus-ring mono text-micro text-graphite hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      <span className="flex items-center gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
            if (e.key === 'Escape') setDraft('')
          }}
          placeholder="Singapore…"
          aria-label="Add a geography"
          className="focus-ring h-5.5 w-32 border border-rule bg-transparent px-2 text-label outline-none placeholder:text-graphite"
        />
        <button
          type="button"
          aria-label="Add geography"
          title="Add geography"
          onClick={add}
          className="focus-ring flex h-5.5 w-5.5 items-center justify-center mono text-ui text-primary hover:bg-bone"
        >
          +
        </button>
      </span>
    </>
  )
}

function CheckSizeInputs({
  checkMin,
  checkMax,
  currency,
  onSave,
}: {
  checkMin: number | null
  checkMax: number | null
  currency: string | null
  onSave: (patch: {
    checkMin?: number | null
    checkMax?: number | null
    currency?: string | null
  }) => void
}) {
  // Grouped as they print: `100,000`. A commit reads the digits back.
  const [min, setMin] = useState(formatNumber(checkMin, 0))
  const [max, setMax] = useState(formatNumber(checkMax, 0))
  const [cur, setCur] = useState(currency ?? '')

  function commit() {
    const parse = (s: string) => {
      const n = Number(s.replace(/[,\s]/g, ''))
      return s.trim() === '' || !Number.isFinite(n) ? null : Math.round(n)
    }
    const lo = parse(min)
    const hi = parse(max)
    setMin(formatNumber(lo, 0))
    setMax(formatNumber(hi, 0))
    onSave({ checkMin: lo, checkMax: hi, currency: cur.trim() || null })
  }

  const input =
    'focus-ring h-[1.625rem] rounded-md border border-rule bg-transparent px-2 mono text-ui outline-none placeholder:text-graphite'

  return (
    <>
      <input
        value={cur}
        onChange={(e) => setCur(e.target.value.toUpperCase())}
        onBlur={commit}
        placeholder="USD"
        aria-label="Currency"
        className={cn(input, 'w-14')}
      />
      <input
        value={min}
        onChange={(e) => setMin(e.target.value)}
        onBlur={commit}
        placeholder="Min"
        inputMode="numeric"
        aria-label="Minimum check"
        className={cn(input, 'w-30 text-right')}
      />
      <span className="mono text-label text-graphite">–</span>
      <input
        value={max}
        onChange={(e) => setMax(e.target.value)}
        onBlur={commit}
        placeholder="Max"
        inputMode="numeric"
        aria-label="Maximum check"
        className={cn(input, 'w-30 text-right')}
      />
    </>
  )
}

// ---------- prose ----------

function MandateProse({
  noteId,
  note,
  onState,
}: {
  noteId: string
  note: { bodyJson: NoteBody | null; title: string }
  onState: (state: SaveState) => void
}) {
  const latest = useRef<{
    document: NoteBody
    blocksToMarkdownLossy: () => Promise<string>
  } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    const snapshot = latest.current
    if (!snapshot) return
    onState('saving')
    try {
      const doc = snapshot.document
      const lossyMd = await snapshot.blocksToMarkdownLossy()
      await saveNote({
        data: {
          id: noteId,
          title: note.title || 'Mandate',
          body: {
            bodyJson: doc,
            bodyMd: deriveMarkdown(lossyMd, doc),
            mentionIds: extractMentionIds(doc),
          },
        },
      })
      onState('saved')
    } catch {
      onState('dirty')
    }
  }, [noteId, note.title, onState])

  const scheduleSave = useCallback(() => {
    onState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void flush()
    }, 800)
  }, [flush, onState])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  // The measure: prose caps at 640px, left-aligned at the gutter — the
  // sheet comes out of the instrument at the margin, never centered.
  return (
    <div className="prose-note max-w-160">
      <ClientOnly fallback={<div className="min-h-40" />}>
        <NoteEditor
          initialContent={note.bodyJson}
          onChange={(editor) => {
            latest.current = editor
            scheduleSave()
          }}
        />
      </ClientOnly>
    </div>
  )
}
