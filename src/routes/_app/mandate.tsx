import { ClientOnly, createFileRoute, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  deriveMarkdown,
  extractMentionIds,
  NoteEditor,
} from '#/components/editor/note-editor'
import { EmptyState } from '#/components/empty-state'
import { PageHeader } from '#/components/page-header'
import { Button } from '#/components/ui/button'
import { badgeStyle, optionColor } from '#/lib/attributes/colors'
import {
  createMandate,
  getMandate,
  getNote,
  listRegistry,
  saveNote,
  updateMandateFacts,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import type { NoteBody } from '#/db/schema/kinds'

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
  const [creating, setCreating] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [savedAt, setSavedAt] = useState<string | null>(null)

  if (!mandate) {
    return (
      <div className="flex min-h-full flex-col">
        <PageHeader title="Mandate" description={<span>not written</span>} />
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
      ? 'saving…'
      : saveState === 'dirty'
        ? 'unsaved'
        : saveState === 'saved' && savedAt
          ? `saved · ${savedAt}`
          : ''

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Mandate"
        description={
          <>
            <span>updated {note.updatedAt.slice(0, 10)}</span>
            <span>
              {activeStages} stage{activeStages === 1 ? '' : 's'} ·{' '}
              {mandate.geos.length} geo{mandate.geos.length === 1 ? '' : 's'}
            </span>
          </>
        }
        action={
          <span
            className="mono text-micro text-graphite"
            role="status"
            aria-live="polite"
          >
            {status}
          </span>
        }
      />

      <FactsGrid mandate={mandate} stageOptions={stageOptions} />

      <div className="px-8 pt-6 pb-8">
        <MandateProse
          noteId={note.id}
          note={note}
          onState={(s) => {
            setSaveState(s)
            if (s === 'saved') setSavedAt(new Date().toTimeString().slice(0, 5))
          }}
        />
      </div>
    </div>
  )
}

// ---------- facts grid ----------

type Mandate = NonNullable<Awaited<ReturnType<typeof getMandate>>>

/** One row of the grid: 96px caps label, values, a mono note on the right. */
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
      <div className="w-24 shrink-0 label-caps text-[0.625rem] leading-3 font-normal text-graphite">
        {label}
      </div>
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

  // Archived stages leave the picker (spec §3: writes never assert them)
  // but a mandate that already names one keeps it, greyed.
  const stages = stageOptions.filter(
    (opt) => !opt.archived || mandate.stages.includes(opt.id),
  )

  return (
    <div className="flex shrink-0 flex-col border-b border-hairline px-8">
      <FactRow
        label="Stages"
        note={`${mandate.stages.length} of ${stages.length} · click toggles`}
      >
        {stages.map((opt) => {
          const active = mandate.stages.includes(opt.id)
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={active}
              onClick={() =>
                save({
                  stages: active
                    ? mandate.stages.filter((s) => s !== opt.id)
                    : [...mandate.stages, opt.id],
                })
              }
              className={cn(
                'focus-ring flex h-5 items-center px-1.5 mono text-micro font-medium transition-colors',
                !active &&
                  'border border-dashed border-rule font-normal text-graphite hover:border-hairline hover:text-foreground',
              )}
              style={active ? badgeStyle(optionColor(opt, 0)) : undefined}
            >
              {opt.label}
            </button>
          )
        })}
      </FactRow>

      <FactRow label="Geographies">
        <GeoChips geos={mandate.geos} onSave={(geos) => save({ geos })} />
      </FactRow>

      <FactRow label="Check size" note="whole units · flags, never blocks" last>
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

function GeoChips({
  geos,
  onSave,
}: {
  geos: Array<string>
  onSave: (geos: Array<string>) => void
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  function add() {
    const v = draft.trim()
    setDraft('')
    setAdding(false)
    if (!v) return
    if (geos.some((g) => g.toLowerCase() === v.toLowerCase())) return
    onSave([...geos, v])
  }

  return (
    <>
      {geos.map((g) => (
        <span
          key={g}
          className="flex h-[1.375rem] items-center gap-2 border border-rule bg-paper px-2 text-label font-medium"
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
      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
            if (e.key === 'Escape') {
              setDraft('')
              setAdding(false)
            }
          }}
          placeholder="India, US…"
          aria-label="Add geography"
          className="focus-ring h-[1.375rem] w-44 border border-rule bg-transparent px-2 text-label outline-none placeholder:text-graphite"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="focus-ring flex h-[1.375rem] items-center gap-1.5 border border-dashed border-rule px-2 text-label text-graphite transition-colors hover:border-hairline hover:text-foreground"
        >
          <span className="mono text-primary">+</span>
          Add a geography…
          <kbd className="mono text-micro">↵</kbd>
        </button>
      )}
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
  const [min, setMin] = useState(checkMin?.toString() ?? '')
  const [max, setMax] = useState(checkMax?.toString() ?? '')
  const [cur, setCur] = useState(currency ?? '')

  function commit() {
    const parse = (s: string) => {
      const n = Number(s.replace(/[,\s]/g, ''))
      return s.trim() === '' || !Number.isFinite(n) ? null : Math.round(n)
    }
    onSave({
      checkMin: parse(min),
      checkMax: parse(max),
      currency: cur.trim() || null,
    })
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
