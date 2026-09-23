import { useRouter } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { backfillConfirmOptions, confirmThenStart } from './embed-backfill-flow'
import { SettingsRow, SettingsSection } from './settings-section'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import type { SelectItem } from '#/components/ui/select'
import {
  EMBEDDING_PROVIDERS,
  EMBEDDING_PROVIDER_INFO,
  NO_PIN_HEADLINE,
  PIN_DIMS,
  backfillEstimateLine,
  backfillProgressLine,
  modelsFor,
  needsRepinNote,
  pinHeadline,
  pinSwapNote,
} from '#/lib/ai/providers/embed/ids'
import type {
  EmbeddingModelInfo,
  EmbeddingProvider,
} from '#/lib/ai/providers/embed/ids'
import type { getEmbeddingSettings } from '#/lib/server-fns'
import {
  getEmbedBackfill,
  pinEmbedding,
  saveEmbeddingKey,
  startEmbedBackfill,
  testEmbedding,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

type EmbeddingSettings = Awaited<ReturnType<typeof getEmbeddingSettings>>
type TestResult = Awaited<ReturnType<typeof testEmbedding>>
type BackfillView = Awaited<ReturnType<typeof getEmbedBackfill>>

/**
 * Settings → AI · Embeddings (SPA-51, `docs/spec-ai-substrate.md` §9) — the
 * embedding pin, in the settings-ledger shape the Providers, Routing and Caps
 * sections use: a head whose readout is the pin in one sentence, the
 * provider row, a ledger of that provider's models, the key row, then the
 * Test and Pin actions.
 *
 * Its words are its safety mechanism. A model that cannot emit the
 * workspace's 768 stays in the ledger, greyed on bone-deep with its note
 * ("needs re-pin — emits 1536, this workspace stores 768") and no control,
 * so the admin sees why rather than wondering where it went. Once pinned,
 * choosing another 768-wide model is a swap (SPA-136): the action row says
 * what it does to the stored vectors, the button reads Swap and asks first,
 * and the swap offers the backfill below rather than starting it. A model
 * of another width is never choosable here, and the server refuses it
 * `PinLocked` regardless.
 *
 * The Backfill block (SPA-136) shows how many chunks carry the pinned model
 * and what embedding the rest would cost; its button asks with that
 * estimate before anything is queued.
 */
export function EmbeddingsSection({
  settings,
  backfill,
}: {
  settings: EmbeddingSettings
  backfill: BackfillView
}) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const { pin, keys } = settings
  const [provider, setProvider] = useState<EmbeddingProvider>(
    pin?.provider ?? 'openai',
  )
  const [model, setModel] = useState<string>(pin?.model ?? '')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<'key' | 'test' | 'pin' | null>(null)
  const [result, setResult] = useState<TestResult | null>(null)

  const descriptor = EMBEDDING_PROVIDER_INFO[provider]
  const keyRow = keys.find((k) => k.provider === provider)
  const models = modelsFor(provider)
  const chosen = models.find((m) => m.id === model && m.emitsPin)
  const isPinned =
    pin !== null && pin.provider === provider && pin.model === model
  // The pin a chosen same-width model would replace: the note names it.
  const swapFrom =
    pin !== null && chosen !== undefined && !isPinned ? pin : null
  const canCall = chosen !== undefined && keyRow?.configured === true

  const providerItems: Array<SelectItem<EmbeddingProvider>> =
    EMBEDDING_PROVIDERS.map((id) => ({
      value: id,
      label: EMBEDDING_PROVIDER_INFO[id].label,
    }))

  function chooseProvider(next: EmbeddingProvider) {
    setProvider(next)
    setModel(pin?.provider === next ? pin.model : '')
    setResult(null)
    setError(null)
  }

  function chooseModel(next: EmbeddingModelInfo) {
    setModel(next.id)
    setResult(null)
    setError(null)
  }

  async function saveKey() {
    if (!key.trim()) {
      setError(`Paste a ${descriptor.label} key.`)
      return
    }
    setPending('key')
    setError(null)
    try {
      const { display } = await saveEmbeddingKey({
        data: { provider, key: key.trim() },
      })
      setKey('')
      toast(`${descriptor.label} embedding key saved · ${display}`)
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key')
    } finally {
      setPending(null)
    }
  }

  async function test() {
    if (!chosen) return
    setPending('test')
    setResult(null)
    try {
      setResult(await testEmbedding({ data: { provider, model: chosen.id } }))
      void router.invalidate()
    } catch (err) {
      setResult({
        ok: false,
        status: null,
        message: err instanceof Error ? err.message : 'The test did not run',
      })
    } finally {
      setPending(null)
    }
  }

  async function pinIt() {
    if (!chosen) return
    if (swapFrom) {
      const ok = await confirm({
        title: `Swap to ${chosen.id}?`,
        body: pinSwapNote(swapFrom, { provider, model: chosen.id }),
        action: 'Swap',
      })
      if (!ok) return
    }
    setPending('pin')
    setError(null)
    try {
      const pinned = await pinEmbedding({
        data: { provider, model: chosen.id },
      })
      toast(
        swapFrom
          ? `${pinHeadline(pinned)} Backfill re-embeds what is stored.`
          : pinHeadline(pinned),
      )
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not pin')
    } finally {
      setPending(null)
    }
  }

  return (
    <SettingsSection
      title="Embeddings"
      blurb="Which model turns text into vectors for search. Search reads only the pinned model's vectors."
      crumb="Workspace"
    >
      <div className="flex flex-col pt-5">
        <div className="flex items-baseline gap-3 border-b border-hairline pb-2">
          <h3 className="label-caps text-foreground">Pin</h3>
          <span className="mono text-micro text-graphite">
            {pin ? pinHeadline(pin) : NO_PIN_HEADLINE}
          </span>
        </div>

        <SettingsRow
          label="Provider"
          hint="Where text is sent to be embedded. Every provider here is cloud."
        >
          <Select<EmbeddingProvider>
            value={provider}
            onChange={chooseProvider}
            items={providerItems}
            width="trigger"
            aria-label="Embedding provider"
            className="w-56"
          />
        </SettingsRow>

        <div className="flex h-8 items-center gap-3 border-b border-hairline field-label leading-4 text-graphite">
          <span className="w-5 shrink-0" />
          <span className="w-56 shrink-0">Model</span>
          <span className="w-20 shrink-0">Emits</span>
          <span className="min-w-0 flex-1">At {PIN_DIMS}</span>
        </div>
        <ol
          role="radiogroup"
          aria-label={`${descriptor.label} embedding model`}
        >
          {models.map((m) =>
            m.emitsPin ? (
              <ModelRow
                key={m.id}
                model={m}
                on={m.id === model}
                pinned={pin?.provider === provider && pin.model === m.id}
                onChoose={() => chooseModel(m)}
              />
            ) : (
              <GreyedModelRow key={m.id} model={m} />
            ),
          )}
        </ol>

        <SettingsRow
          label={
            keyRow?.configured
              ? `Replace ${descriptor.label} embedding key`
              : `${descriptor.label} embedding key`
          }
          hint={
            keyRow?.configured
              ? `Saved as ${keyRow.display ?? '••••'}. Its own key, apart from the ${descriptor.label} provider key.`
              : 'Stored encrypted as the workspace embedding key, apart from any provider key.'
          }
        >
          <Input
            id={`embed-${provider}-key`}
            aria-label={`${descriptor.label} embedding API key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              keyRow?.configured ? '••••••••' : descriptor.keyPlaceholder
            }
            className="w-72 mono"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void saveKey()}
            disabled={pending !== null}
          >
            Save key
          </Button>
        </SettingsRow>

        <div className="flex min-h-12 items-center justify-end gap-3 border-b border-rule py-2">
          {error ? (
            <span
              role="alert"
              className="mr-auto mono text-micro text-destructive"
            >
              {error}
            </span>
          ) : swapFrom ? (
            <p role="status" className="mr-auto text-label text-warning">
              {pinSwapNote(swapFrom, { provider, model })}
            </p>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void test()}
            disabled={pending !== null || !canCall}
          >
            {pending === 'test' ? 'Testing' : 'Test'}
          </Button>
          <Button
            size="sm"
            onClick={() => void pinIt()}
            disabled={pending !== null || !canCall || isPinned}
          >
            {isPinned ? 'Pinned' : swapFrom ? 'Swap' : 'Pin'}
          </Button>
        </div>

        {result ? (
          <div
            role="status"
            className="flex min-h-9 items-start gap-3 border-b border-rule py-2"
          >
            <span
              className={cn(
                'w-28 shrink-0 mono text-micro',
                result.ok ? 'text-graphite' : 'text-destructive',
              )}
            >
              {result.ok
                ? `${result.width} dims`
                : result.status
                  ? `error ${result.status}`
                  : 'error'}
            </span>
            <span className="min-w-0 flex-1 mono text-label break-words">
              {result.ok
                ? `${result.model} · [${result.head.map((v) => v.toFixed(4)).join(', ')}, …]`
                : result.message}
            </span>
          </div>
        ) : null}

        <div className="flex h-8 items-center justify-between">
          <span className="label-caps font-normal text-graphite">
            {PIN_DIMS} dimensions · admin only
          </span>
          <span className="mono text-micro text-graphite">
            a test embeds one word · its vector is not stored
          </span>
        </div>

        {backfill.pin ? (
          <Backfill initial={backfill} confirm={confirm} />
        ) : null}
      </div>
      {confirmDialog}
    </SettingsSection>
  )
}

type PinnedBackfill = Extract<BackfillView, { pin: object }>

/** The run's state, said in the instrument's own lowercase mono. */
function runLine(view: PinnedBackfill): string {
  const progress = backfillProgressLine(view.embedded, view.total)
  switch (view.run.state) {
    case 'running':
      return `running · ${progress}`
    case 'queued':
      return `queued · ${progress}`
    case 'paused':
      return `paused by the AI cap · resumes ${view.run.resumesAt.slice(0, 16).replace('T', ' ')} utc · ${progress}`
    case 'failed':
    case 'idle':
      return progress
  }
}

/**
 * The Backfill block: progress, the estimate for what is left, and the one
 * button. The button opens the confirm with the estimate on it; only a yes
 * calls `startEmbedBackfill`. While a run is queued or running the block
 * polls `getEmbedBackfill` — a count and a queue read, no provider call.
 */
function Backfill({
  initial,
  confirm,
}: {
  initial: PinnedBackfill
  confirm: ReturnType<typeof useConfirm>['confirm']
}) {
  const [view, setView] = useState<BackfillView>(initial)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A swap or a pin re-runs the loader; the block follows it.
  useEffect(() => setView(initial), [initial])

  const refresh = useCallback(async () => {
    setView(await getEmbedBackfill())
  }, [])

  const live =
    view.pin !== null &&
    (view.run.state === 'queued' || view.run.state === 'running')
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [live, refresh])

  if (view.pin === null) return null
  const { estimate, run } = view
  const busy =
    run.state === 'queued' || run.state === 'running' || run.state === 'paused'

  async function start() {
    if (view.pin === null) return
    setError(null)
    setStarting(true)
    try {
      const started = await confirmThenStart(
        confirm,
        backfillConfirmOptions(estimate, view.pin.model),
        () => startEmbedBackfill(),
      )
      if (started === null) return
      if (started.status === 'queue-unavailable')
        setError('The worker queue is unreachable; try again shortly')
      if (started.status === 'already-queued') toast.message('Already queued')
      if (started.status === 'nothing-to-do')
        toast.message('Every chunk already carries the pinned model')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start')
    } finally {
      setStarting(false)
    }
  }

  return (
    <>
      <div className="flex items-baseline gap-3 border-b border-hairline pt-5 pb-2">
        <h3 className="label-caps text-foreground">Backfill</h3>
        <span className="tabular mono text-micro text-graphite">
          {runLine(view)}
        </span>
      </div>
      <SettingsRow
        label="Embed what is stored"
        hint={
          estimate.chunks === 0
            ? `Every chunk carries ${view.pin.model}. New ones are embedded as they arrive.`
            : 'Asks with this estimate first. Sensitive records are left out.'
        }
      >
        {estimate.chunks > 0 ? (
          <span className="tabular mono text-micro text-graphite">
            {backfillEstimateLine(estimate)}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void start()}
          disabled={starting || busy || estimate.chunks === 0}
        >
          Backfill
        </Button>
      </SettingsRow>
      {error || run.state === 'failed' ? (
        <div className="flex min-h-9 items-center border-b border-rule py-2">
          <span role="alert" className="mono text-micro text-destructive">
            {error ?? (run.state === 'failed' ? run.reason : null)}
          </span>
        </div>
      ) : null}
    </>
  )
}

/** A model that can emit the pin's width: a radio row, wash + check when chosen. */
function ModelRow({
  model,
  on,
  pinned,
  onChoose,
}: {
  model: EmbeddingModelInfo
  on: boolean
  pinned: boolean
  onChoose: () => void
}) {
  return (
    <li className="border-b border-rule">
      <button
        type="button"
        role="radio"
        aria-checked={on}
        onClick={onChoose}
        className={cn(
          'focus-ring-inset flex h-row w-full items-center gap-3 text-left transition-colors',
          on ? 'bg-selected' : 'hover:bg-bone',
        )}
      >
        <span aria-hidden className="flex w-5 shrink-0 justify-center">
          <span
            className={cn(
              'flex size-3.5 items-center justify-center border border-hairline',
              on ? 'bg-primary text-paper' : 'bg-paper',
            )}
          >
            {on ? <Check className="size-2.5" strokeWidth={2.5} /> : null}
          </span>
        </span>
        <span className="w-56 shrink-0 truncate mono text-label text-foreground">
          {model.id}
        </span>
        <span className="tabular w-20 shrink-0 mono text-micro text-graphite">
          {model.nativeDims}
        </span>
        <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
          {pinned
            ? `pinned · ${PIN_DIMS}`
            : model.nativeDims === PIN_DIMS
              ? `${PIN_DIMS} native`
              : `${PIN_DIMS} on request`}
        </span>
      </button>
    </li>
  )
}

/**
 * A model that cannot emit the pin's width: on bone-deep, graphite, no
 * control — `aria-disabled` so it is announced and never chosen — and its
 * note in the last lane with the model's real width.
 */
function GreyedModelRow({ model }: { model: EmbeddingModelInfo }) {
  return (
    <li
      aria-disabled="true"
      className="flex h-row items-center gap-3 border-b border-rule bg-bone-deep text-graphite"
    >
      <span className="w-5 shrink-0" />
      <span className="w-56 shrink-0 truncate mono text-label">{model.id}</span>
      <span className="tabular w-20 shrink-0 mono text-micro">
        {model.nativeDims}
      </span>
      <span className="min-w-0 flex-1 truncate mono text-micro">
        {needsRepinNote(model)}
      </span>
    </li>
  )
}
