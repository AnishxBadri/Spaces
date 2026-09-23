import { useRouter } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { SettingsRow, SettingsSection } from './settings-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import type { SelectItem } from '#/components/ui/select'
import {
  EMBEDDING_PROVIDERS,
  EMBEDDING_PROVIDER_INFO,
  NO_PIN_HEADLINE,
  PIN_DIMS,
  modelsFor,
  needsRepinNote,
  pinHeadline,
  pinLockedMessage,
} from '#/lib/ai/providers/embed/ids'
import type {
  EmbeddingModelInfo,
  EmbeddingProvider,
} from '#/lib/ai/providers/embed/ids'
import type { getEmbeddingSettings } from '#/lib/server-fns'
import { pinEmbedding, saveEmbeddingKey, testEmbedding } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

type EmbeddingSettings = Awaited<ReturnType<typeof getEmbeddingSettings>>
type TestResult = Awaited<ReturnType<typeof testEmbedding>>

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
 * choosing any other model puts the refusal in the action row and holds
 * Pin; the server refuses the same change `PinLocked` regardless.
 */
export function EmbeddingsSection({
  settings,
}: {
  settings: EmbeddingSettings
}) {
  const router = useRouter()
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
  // The pin another model would have to move: the refusal names it.
  const lockedTo =
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
    setPending('pin')
    setError(null)
    try {
      const pinned = await pinEmbedding({
        data: { provider, model: chosen.id },
      })
      toast(pinHeadline(pinned))
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
      blurb="Which model turns text into vectors for search. Pinned once: every stored vector is that model's."
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
          {lockedTo ? (
            <p role="status" className="mr-auto text-label text-warning">
              {pinLockedMessage(lockedTo)}
            </p>
          ) : error ? (
            <span
              role="alert"
              className="mr-auto mono text-micro text-destructive"
            >
              {error}
            </span>
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
            disabled={
              pending !== null || !canCall || lockedTo !== null || isPinned
            }
          >
            {isPinned ? 'Pinned' : 'Pin'}
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
      </div>
    </SettingsSection>
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
