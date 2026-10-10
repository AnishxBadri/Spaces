import { Link, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { backfillConfirmOptions, confirmThenStart } from './embed-backfill-flow'
import { useSettingsDraft } from './settings-form'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsSection,
  SettingsTip,
} from './settings-section'
import { ReadoutStrip } from '#/components/record/record-parts'
import type { RecordReadout } from '#/components/record/record-parts'
import { Button } from '#/components/ui/button'
import { Checkbox, radioClasses } from '#/components/ui/checkbox'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import type { SelectItem } from '#/components/ui/select'
import {
  EMBEDDING_PROVIDERS,
  EMBEDDING_PROVIDER_INFO,
  KEYED_EMBEDDING_PROVIDERS,
  NO_SLOT_HEADLINE,
  OLLAMA_URL_GUIDANCE,
  PIN_DIMS,
  backfillEstimateLine,
  backfillProgressLine,
  modelsFor,
  needsRepinNote,
  pinHeadline,
  pinSwapNote,
  reusedKeyLine,
  sensitiveEstimateLine,
  slotHeadline,
  slotSearchNote,
} from '#/lib/ai/providers/embed/ids'
import { formatNumber } from '@spaces/core/format'
import type {
  EmbeddingModelInfo,
  EmbeddingPinView,
  EmbeddingProvider,
} from '#/lib/ai/providers/embed/ids'
import type { getEmbeddingSettings } from '#/lib/server-fns'
import {
  clearSensitiveSlot,
  getEmbedBackfill,
  pinEmbedding,
  saveEmbeddingKey,
  setSensitiveSlot,
  startEmbedBackfill,
  testEmbedding,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

type EmbeddingSettings = Awaited<ReturnType<typeof getEmbeddingSettings>>
type EmbeddingKeyRow = EmbeddingSettings['keys'][number]
type TestResult = Awaited<ReturnType<typeof testEmbedding>>
type BackfillView = Awaited<ReturnType<typeof getEmbedBackfill>>

/**
 * Settings → AI → Search — the embedding pin: three readouts (how much is
 * searchable by meaning, what waits, where sensitive records go), then
 * Model (the provider, its models as radios, the key, Test and Pin),
 * Sensitive records and Catch up.
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
 * Ollama (SPA-83) is a provider row like the rest, flagged local, with no
 * key of its own: its key row is the address it borrows from Settings → AI ·
 * Providers, with where to point it. Once a local model has tested green,
 * the Sensitive slot block offers it beside a cloud pin, and says in its
 * readout what search will and will not read.
 *
 * Catch up (the backfill) shows how many chunks carry the pinned model
 * and what embedding the rest would cost; its button asks with that
 * estimate before anything is queued. With a local route it counts the
 * sensitive chunks apart and prices them "free — local model".
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
  const { pin, slot, keys } = settings
  const [provider, setProvider] = useState<EmbeddingProvider>(
    pin?.provider ?? 'openai',
  )
  const [model, setModel] = useState<string>(pin?.model ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<'test' | 'pin' | null>(null)
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
          ? `${pinHeadline(pinned)} Catch up re-embeds what is stored.`
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
    <SettingsSection title="Search" crumb="AI">
      <ReadoutStrip
        readouts={searchReadouts(backfill)}
        className="border-t-0 border-b border-rule"
      />
      <div className="flex flex-col">
        <SettingsGroupHead
          title="Model"
          action={pin ? `set ${pin.pinnedAt.slice(5, 10)}` : 'not set'}
        />

        <SettingsRow
          label="Provider"
          hint={
            descriptor.local
              ? `${descriptor.label} runs on a box you run; nothing leaves it.`
              : 'Where text is sent to be embedded. Ollama is local; the rest are cloud.'
          }
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

        <div className="flex h-8 items-center gap-3 border-b border-hairline px-3 field-label leading-4 text-graphite">
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

        {descriptor.keyless ? (
          <SettingsRow label={`${descriptor.label} address`}>
            {keyRow?.configured ? (
              <span className="mono text-micro text-graphite">
                {keyRow.baseUrl ?? descriptor.defaultBaseUrl}
              </span>
            ) : (
              <SettingsTip
                tip={`Add ${descriptor.label} under Settings → Models first — no key, only its address. ${OLLAMA_URL_GUIDANCE}`}
              >
                <Button size="sm" variant="outline" asChild>
                  <Link to="/settings/models">Models</Link>
                </Button>
              </SettingsTip>
            )}
          </SettingsRow>
        ) : keyRow?.source === 'models' && keyRow.configured ? (
          <ReusedModelsKey key={provider} provider={provider} keyRow={keyRow} />
        ) : (
          <EmbeddingKeyField
            key={provider}
            provider={provider}
            keyRow={keyRow}
          />
        )}

        <div className="flex min-h-12 items-center justify-end gap-3 border-b border-rule px-3 py-2">
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
            title="Embeds one word; its vector is not stored."
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
            className="flex min-h-9 items-start gap-3 border-b border-rule px-3 py-2"
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

        {pin ? <SensitiveSlot pin={pin} slot={slot} keys={keys} /> : null}

        {backfill.pin ? (
          <Backfill initial={backfill} confirm={confirm} />
        ) : null}
      </div>
      {confirmDialog}
    </SettingsSection>
  )
}

/**
 * The three readouts: the share of passages searchable by meaning, the
 * chunks waiting for a vector, and where sensitive records go.
 */
function searchReadouts(view: BackfillView): Array<RecordReadout> {
  if (view.pin === null)
    return [
      { label: 'Passages searchable by meaning', value: '—' },
      { label: 'Waiting', value: '—' },
      { label: 'Sensitive records', value: '—' },
    ]
  const waiting = view.estimate.chunks + (view.sensitive?.estimate.chunks ?? 0)
  const local =
    EMBEDDING_PROVIDER_INFO[view.pin.provider].local || view.sensitive !== null
  return [
    {
      label: 'Passages searchable by meaning',
      value:
        view.total === 0
          ? '—'
          : `${Math.floor((view.embedded / view.total) * 100)}%`,
    },
    {
      label: 'Waiting',
      value: formatNumber(waiting, 0),
      tone: waiting === 0 ? 'muted' : undefined,
    },
    {
      label: 'Sensitive records',
      value: local ? 'Local' : 'Left out',
      tone: local ? undefined : 'muted',
    },
  ]
}

const LINK =
  'focus-ring self-start rounded-md text-label text-graphite hover:text-foreground'

/**
 * The Models key Search embeds on (D81), as a tick: "Use the OpenAI key
 * from Models", with "Use a different key" under it. Unticked, the
 * provider's own key field opens; a key saved there takes precedence.
 */
function ReusedModelsKey({
  provider,
  keyRow,
}: {
  provider: EmbeddingProvider
  keyRow: EmbeddingKeyRow
}) {
  const [different, setDifferent] = useState(false)
  const id = `embed-${provider}-reuse`
  return (
    <>
      <SettingsRow label="Key">
        <span className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2.5">
            <Checkbox
              id={id}
              checked={!different}
              onCheckedChange={(on) => setDifferent(!on)}
            />
            <label htmlFor={id} className="text-ui text-foreground">
              {reusedKeyLine(provider)}
            </label>
            <span className="mono text-micro text-graphite">
              {keyRow.display ?? '••••'}
            </span>
          </span>
          {different ? null : (
            <button
              type="button"
              onClick={() => setDifferent(true)}
              className={LINK}
            >
              Use a different key
            </button>
          )}
        </span>
      </SettingsRow>
      {different ? (
        <EmbeddingKeyField provider={provider} keyRow={undefined} />
      ) : null}
    </>
  )
}

/**
 * The provider's own embedding key, apart from any provider key: a typed
 * field in the page's Save bar. Write-only — it settles empty after a save,
 * and the redacted display sits beside it.
 */
function EmbeddingKeyField({
  provider,
  keyRow,
}: {
  provider: EmbeddingProvider
  keyRow: EmbeddingKeyRow | undefined
}) {
  const router = useRouter()
  const descriptor = EMBEDDING_PROVIDER_INFO[provider]
  const { draft, set } = useSettingsDraft({ key: '' }, async (next) => {
    const keyed = KEYED_EMBEDDING_PROVIDERS.find((p) => p === provider)
    if (keyed === undefined) return { key: '' }
    const key = next.key.trim()
    if (key === '') throw new Error(`Paste a ${descriptor.label} key.`)
    const { display } = await saveEmbeddingKey({
      data: { provider: keyed, key },
    })
    toast(`${descriptor.label} embedding key saved · ${display}`)
    void router.invalidate()
    return { key: '' }
  })

  return (
    <SettingsRow
      label={
        keyRow?.configured
          ? `Replace ${descriptor.label} embedding key`
          : `${descriptor.label} embedding key`
      }
    >
      <SettingsTip
        tip={`Its own key, apart from the ${descriptor.label} provider key.`}
      >
        <Input
          id={`embed-${provider}-key`}
          aria-label={`${descriptor.label} embedding API key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft.key}
          onChange={(e) => set('key', e.target.value)}
          placeholder={
            keyRow?.configured ? '••••••••' : descriptor.keyPlaceholder
          }
          className="w-72 mono"
        />
      </SettingsTip>
      {keyRow?.configured ? (
        <span className="mono text-micro text-graphite">
          saved {keyRow.display ?? '••••'}
        </span>
      ) : null}
    </SettingsRow>
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
  const { estimate, run, sensitive } = view
  const pendingChunks = estimate.chunks + (sensitive?.estimate.chunks ?? 0)
  const busy =
    run.state === 'queued' || run.state === 'running' || run.state === 'paused'

  async function start() {
    if (view.pin === null) return
    setError(null)
    setStarting(true)
    try {
      const started = await confirmThenStart(
        confirm,
        backfillConfirmOptions(
          estimate,
          view.pin.model,
          sensitive === null
            ? null
            : { estimate: sensitive.estimate, model: sensitive.model },
        ),
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
      <SettingsGroupHead
        title="Catch up"
        action={<span className="tabular">{runLine(view)}</span>}
      />
      <SettingsRow
        label={
          pendingChunks === 0
            ? 'Every passage is embedded'
            : `${formatNumber(pendingChunks, 0)} not embedded yet`
        }
        hint={
          pendingChunks === 0
            ? undefined
            : sensitive === null
              ? 'Asks with this estimate first. Sensitive records are left out.'
              : `Asks with this estimate first. Sensitive records go only to ${sensitive.model}.`
        }
      >
        {pendingChunks > 0 ? (
          <span className="flex flex-col">
            {estimate.chunks > 0 ? (
              <span className="tabular mono text-micro text-graphite">
                {backfillEstimateLine(estimate)}
              </span>
            ) : null}
            {sensitive !== null && sensitive.estimate.chunks > 0 ? (
              <span className="tabular mono text-micro text-graphite">
                {sensitiveEstimateLine(sensitive.estimate)}
              </span>
            ) : null}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void start()}
          disabled={starting || busy || pendingChunks === 0}
        >
          {pendingChunks === 0
            ? 'Embed'
            : `Embed ${formatNumber(pendingChunks, 0)}`}
        </Button>
      </SettingsRow>
      {error || run.state === 'failed' ? (
        <div className="flex min-h-9 items-center border-b border-rule px-3 py-2">
          <span role="alert" className="mono text-micro text-destructive">
            {error ?? (run.state === 'failed' ? run.reason : null)}
          </span>
        </div>
      ) : null}
    </>
  )
}

/**
 * The sensitive slot (SPA-83, D11): a head whose readout says where
 * sensitive records go, then — beside a cloud pin — one row for the local
 * model that has tested green, with Set or Clear. Nothing is offered until a
 * local model is Test-green; with the pin itself local there is nothing to
 * set. The row's hint is the search readout: the semantic lane reads the
 * pin's model only, so a slot on another model embeds sensitive records
 * that semantic search then cannot reach.
 */
function SensitiveSlot({
  pin,
  slot,
  keys,
}: {
  pin: EmbeddingPinView
  slot: EmbeddingSettings['slot']
  keys: ReadonlyArray<EmbeddingKeyRow>
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pinLocal = EMBEDDING_PROVIDER_INFO[pin.provider].local
  const green = keys.flatMap((k) =>
    EMBEDDING_PROVIDER_INFO[k.provider].local &&
    k.configured &&
    k.lastTestOk === true &&
    k.testedModel !== null
      ? [{ provider: k.provider, model: k.testedModel }]
      : [],
  )
  const candidate = slot ?? green.at(0) ?? null

  async function set() {
    if (candidate === null) return
    setPending(true)
    setError(null)
    try {
      const saved = await setSensitiveSlot({
        data: { provider: candidate.provider, model: candidate.model },
      })
      toast(slotHeadline(saved))
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the slot')
    } finally {
      setPending(false)
    }
  }

  async function clear() {
    setPending(true)
    setError(null)
    try {
      await clearSensitiveSlot()
      toast(NO_SLOT_HEADLINE)
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear the slot')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <SettingsGroupHead
        title="Sensitive records"
        action={pinLocal ? 'the pin is local' : slot ? 'local' : 'left out'}
      />
      {pinLocal ? (
        <SettingsRow
          label="Embed them with"
          hint="Sensitive text stays on your box."
        >
          <span className="mono text-label">
            {EMBEDDING_PROVIDER_INFO[pin.provider].label} · {pin.model}
          </span>
        </SettingsRow>
      ) : candidate === null ? (
        <SettingsRow
          label="Embed them with"
          hint="Offered once a local model tests green above. Until then sensitive records stay unembedded; nothing is sent to the cloud pin."
        />
      ) : (
        <SettingsRow
          label="Embed them with"
          hint={slotSearchNote(pin, candidate)}
        >
          <span className="mono text-label">
            {EMBEDDING_PROVIDER_INFO[candidate.provider].label} ·{' '}
            {candidate.model}
          </span>
          <span className="tabular mono text-micro text-graphite">
            {slot ? `slot · ${PIN_DIMS}` : `tested · ${PIN_DIMS}`}
          </span>
          {slot ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void clear()}
              disabled={pending}
            >
              Clear
            </Button>
          ) : (
            <Button size="sm" onClick={() => void set()} disabled={pending}>
              Set
            </Button>
          )}
        </SettingsRow>
      )}
      {error ? (
        <div className="flex min-h-9 items-center border-b border-rule px-3 py-2">
          <span role="alert" className="mono text-micro text-destructive">
            {error}
          </span>
        </div>
      ) : null}
    </>
  )
}

/** A model that can emit the pin's width: a radio row, washed when chosen. */
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
          'focus-ring-inset flex h-row w-full items-center gap-3 px-3 text-left transition-colors',
          on ? 'bg-selected' : 'hover:bg-bone',
        )}
      >
        <span aria-hidden className="flex w-5 shrink-0 justify-center">
          <span className={radioClasses({ checked: on })}>
            {on ? <span className="size-1.5 bg-primary" /> : null}
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
      className="flex h-row items-center gap-3 border-b border-rule bg-bone-deep px-3 text-graphite"
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
