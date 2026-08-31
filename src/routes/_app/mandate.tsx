import { ClientOnly, createFileRoute, useRouter } from '@tanstack/react-router'
import { Check, Compass, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  deriveMarkdown,
  extractMentionIds,
  NoteEditor,
} from '#/components/editor/note-editor'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
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

/**
 * The Mandate — the fund's one "why we invest" destination. Prose strategy
 * (a real note, serif register) with a small facts rail: stages, geos,
 * check size. Facts mostly display; the one live consumer is the
 * outside-mandate hint on deal records.
 */
export const Route = createFileRoute('/_app/mandate')({
  loader: async () => {
    const [m, registry] = await Promise.all([
      getMandate(),
      listRegistry({ data: { kind: 'company' } }),
    ])
    const stageAttr = registry.find((a) => a.slug === 'funding_stage')
    const stageOptions =
      (stageAttr?.options as { options?: Array<StageOption> } | null)
        ?.options ?? []
    if (!m) return { mandate: null, note: null, stageOptions }
    const note = await getNote({ data: { id: m.noteEntityId } })
    return { mandate: m, note, stageOptions }
  },
  component: MandatePage,
})

type StageOption = { id: string; label: string; color?: string }

function MandatePage() {
  const { mandate, note, stageOptions } = Route.useLoaderData()
  const router = useRouter()
  const [creating, setCreating] = useState(false)

  if (!mandate || !note) {
    return (
      <div className="mx-auto max-w-[72ch] px-6 py-16 md:px-10">
        <Compass
          className="size-8 text-muted-foreground"
          strokeWidth={1.25}
          aria-hidden
        />
        <h1 className="mt-4 text-display font-semibold tracking-tight">
          State your mandate
        </h1>
        <p className="mt-3 max-w-[52ch] font-serif text-[17px] leading-relaxed text-muted-foreground">
          The mandate is what an LP would read in your deck: where you invest,
          at what stage, at what check size, and why. It isn’t a market claim —
          it’s the standing strategy those claims serve. Deals that fall outside
          it get a quiet flag, never a block; edge cases are the job.
        </p>
        <Button
          className="mt-6"
          disabled={creating}
          onClick={async () => {
            setCreating(true)
            try {
              await createMandate()
              router.invalidate()
            } catch {
              toast.error('Could not create the mandate')
              setCreating(false)
            }
          }}
        >
          {creating ? 'Creating…' : 'Write the mandate'}
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 md:px-10">
      <header className="flex items-center gap-2">
        <Compass
          className="size-5 text-muted-foreground"
          strokeWidth={1.5}
          aria-hidden
        />
        <h1 className="text-page font-semibold tracking-tight">Mandate</h1>
      </header>

      <div className="mt-6 grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)]">
        <FactsRail mandate={mandate} stageOptions={stageOptions} />
        <MandateProse noteId={note.id} note={note} />
      </div>
    </div>
  )
}

// ---------- facts rail ----------

type Mandate = NonNullable<Awaited<ReturnType<typeof getMandate>>>

function FactsRail({
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
      router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    }
  }

  return (
    <aside className="space-y-6">
      <section>
        <h2 className="text-label font-medium text-muted-foreground">Stages</h2>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {stageOptions.map((opt) => {
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
                  'flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium focus-ring transition-colors',
                  active
                    ? ''
                    : 'border border-border text-muted-foreground hover:border-input hover:text-foreground',
                )}
                style={active ? badgeStyle(optionColor(opt, 0)) : undefined}
              >
                {active ? <Check className="size-3" strokeWidth={2.5} /> : null}
                {opt.label}
              </button>
            )
          })}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Company stages you invest at. Powers the outside-mandate hint on
          deals.
        </p>
      </section>

      <GeoEditor geos={mandate.geos} onSave={(geos) => save({ geos })} />

      <CheckSizeEditor
        checkMin={mandate.checkMin}
        checkMax={mandate.checkMax}
        currency={mandate.currency}
        onSave={(patch) => save(patch)}
      />
    </aside>
  )
}

function GeoEditor({
  geos,
  onSave,
}: {
  geos: Array<string>
  onSave: (geos: Array<string>) => void
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const v = draft.trim()
    if (!v) return
    if (geos.some((g) => g.toLowerCase() === v.toLowerCase())) {
      setDraft('')
      return
    }
    onSave([...geos, v])
    setDraft('')
  }

  return (
    <section>
      <h2 className="text-label font-medium text-muted-foreground">
        Geographies
      </h2>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {geos.map((g) => (
          <span
            key={g}
            className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium"
          >
            {g}
            <button
              type="button"
              aria-label={`Remove ${g}`}
              onClick={() => onSave(geos.filter((x) => x !== g))}
              className="rounded-full text-muted-foreground focus-ring hover:text-foreground"
            >
              <X className="size-3" strokeWidth={2} />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder="India, US…"
          className="h-8 text-ui"
          aria-label="Add geography"
        />
        <Button size="sm" variant="outline" onClick={add}>
          <Plus className="size-3" strokeWidth={2} />
        </Button>
      </div>
    </section>
  )
}

function CheckSizeEditor({
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

  return (
    <section>
      <h2 className="text-label font-medium text-muted-foreground">
        Check size
      </h2>
      <div className="mt-2 flex items-center gap-1.5">
        <Input
          value={cur}
          onChange={(e) => setCur(e.target.value.toUpperCase())}
          onBlur={commit}
          placeholder="USD"
          className="h-8 w-16 numeric text-ui"
          aria-label="Currency"
        />
        <Input
          value={min}
          onChange={(e) => setMin(e.target.value)}
          onBlur={commit}
          placeholder="Min"
          inputMode="numeric"
          className="h-8 numeric text-ui"
          aria-label="Minimum check"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <Input
          value={max}
          onChange={(e) => setMax(e.target.value)}
          onBlur={commit}
          placeholder="Max"
          inputMode="numeric"
          className="h-8 numeric text-ui"
          aria-label="Maximum check"
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Whole units. Portfolio construction belongs in the prose.
      </p>
    </section>
  )
}

// ---------- prose ----------

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved'

function MandateProse({
  noteId,
  note,
}: {
  noteId: string
  note: { bodyJson: unknown; title: string }
}) {
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const latest = useRef<{
    document: unknown
    blocksToMarkdownLossy: () => Promise<string>
  } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    const snapshot = latest.current
    if (!snapshot) return
    setSaveState('saving')
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
      setSaveState('saved')
    } catch {
      setSaveState('dirty')
    }
  }, [noteId, note.title])

  const scheduleSave = useCallback(() => {
    setSaveState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, 800)
  }, [flush])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <div>
      <div className="flex h-5 items-center justify-end">
        <span
          className="text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved'
              : saveState === 'dirty'
                ? 'Unsaved changes'
                : ''}
        </span>
      </div>
      <div className="prose-note">
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
    </div>
  )
}
