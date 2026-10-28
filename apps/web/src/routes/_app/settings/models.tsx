import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { PluginMark } from '#/components/integrations/integration-ledger'
import { useSettingsDraft } from '#/components/settings/settings-form'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsSection,
  SettingsTip,
} from '#/components/settings/settings-section'
import { LedgerRow } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Segmented } from '#/components/ui/segmented'
import { Select } from '#/components/ui/select'
import type { SelectItem } from '#/components/ui/select'
import { AI_SENSITIVITIES, MODELS_GRID_LANES } from '#/lib/ai/lanes'
import type { AiLane, AiSensitivity } from '#/lib/ai/lanes'
import { PROVIDERS, isLocalProvider } from '#/lib/ai/providers/ids'
import type { LlmProvider } from '#/lib/ai/providers/ids'
import { formatHeaderLines } from '#/lib/ai/providers/meta'
import {
  getEmbeddingSettings,
  getSensitivityDefault,
  listAiProviders,
  listAiRoutes,
  saveAiKey,
  setAiRoute,
  setSensitivityDefault,
  testAiProvider,
} from '#/lib/server-fns'
import { formatWhen } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

type ProviderRow = Awaited<ReturnType<typeof listAiProviders>>[number]
type RouteRow = Awaited<ReturnType<typeof listAiRoutes>>[number]
type TestResult = Awaited<ReturnType<typeof testAiProvider>>
type EmbeddingPin = Awaited<ReturnType<typeof getEmbeddingSettings>>['pin']

/**
 * Settings → AI → Models: the workspace sensitivity floor, the vault's LLM
 * keys (Providers) and who does each job (the lane × sensitivity grid),
 * admin-only.
 * - One provider opens in place at a time; its typed fields join the page's
 *   Save bar while it is open. What differs between providers is data in
 *   `PROVIDERS`, never a branch on the id.
 * - Radios and selects save alone, at once.
 * - The embed lane is Search's: the grid shows one line pointing there.
 * - A member reads the same page, keys redacted and every control disabled.
 */
export const Route = createFileRoute('/_app/settings/models')({
  loader: async () => {
    const [providers, routes, sensitivityDefault, embedding] =
      await Promise.all([
        listAiProviders(),
        listAiRoutes(),
        getSensitivityDefault(),
        getEmbeddingSettings(),
      ])
    return {
      providers,
      routes,
      sensitivityDefault,
      embeddingPin: embedding.pin,
    }
  },
  component: ModelsRoute,
})

function ModelsRoute() {
  const { providers, routes, sensitivityDefault, embeddingPin } =
    Route.useLoaderData()
  return (
    <SettingsSection title="Models" crumb="AI">
      <SensitivityGroup stored={sensitivityDefault} />
      <ProvidersGroup providers={providers} />
      <RoutingGroup
        providers={providers}
        routes={routes}
        embeddingPin={embeddingPin}
      />
    </SettingsSection>
  )
}

const SENSITIVITY_CHOICE: Record<
  AiSensitivity,
  { label: string; line: string }
> = {
  normal: { label: 'Normal', line: 'Any routed model may read it.' },
  sensitive: {
    label: 'Sensitive',
    line: 'Only local models read it, and no plugin sees it.',
  },
}

/**
 * Sensitivity — the workspace floor (`sensitivity_default`), a `Segmented`
 * with the chosen floor's line under it. It can only raise a record's
 * sensitivity: Sensitive sends every call to the local lanes; Normal leaves
 * each record's own flag and its spaces to decide. A choice saves at once.
 */
function SensitivityGroup({ stored }: { stored: AiSensitivity }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function choose(next: AiSensitivity) {
    if (next === stored) return
    setPending(true)
    try {
      await setSensitivityDefault({ data: { sensitivity: next } })
      toast(
        `Every record treated as ${SENSITIVITY_CHOICE[next].label.toLowerCase()}`,
      )
      void router.invalidate()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save the sensitivity',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col">
      <SettingsGroupHead
        title="Sensitivity"
        action="a record can be raised, never lowered"
      />
      <div className="flex items-start gap-6 border-b border-rule py-3">
        <span className="w-[13.125rem] shrink-0 text-ui font-medium">
          Treat every record as
        </span>
        <div className="flex flex-col gap-1.5">
          <Segmented
            label="Treat every record as"
            value={stored}
            disabled={pending}
            options={AI_SENSITIVITIES.map((s) => ({
              id: s,
              label: SENSITIVITY_CHOICE[s].label,
            }))}
            onChange={(s) => void choose(s)}
          />
          <span className="text-label text-graphite">
            {SENSITIVITY_CHOICE[stored].line}
          </span>
        </div>
      </div>
    </div>
  )
}

/** An instant as the ledger prints it: `09:41` today, else `8 Oct`. */
function stamp(iso: string | null, now: string): string {
  return iso ? formatWhen(iso, now) : '—'
}

type Status = { word: string; tone: 'ok' | 'bad' | 'none' }

/** The Status lane: whether the provider's last Test answered. */
function statusOf(row: ProviderRow): Status {
  if (!row.configured) return { word: 'not set up', tone: 'none' }
  if (row.status === 'invalid') return { word: 'key refused', tone: 'bad' }
  if (row.lastTestOk === true) return { word: 'works', tone: 'ok' }
  if (row.lastTestOk === false) return { word: 'failed', tone: 'bad' }
  return { word: 'not tested', tone: 'none' }
}

/** The Key lane: the redacted display, or what stands in for one. */
function keyText(row: ProviderRow): string {
  if (row.display) return row.display
  if (PROVIDERS[row.provider].keyless && row.configured) return 'no key'
  return '—'
}

/** The Providers group's anchor, where the collapsed routing row points. */
const PROVIDERS_ANCHOR = 'providers'

// The lanes, shared by the head and every row so they stay one grid.
const LANE = {
  key: 'w-28 shrink-0',
  used: 'w-24 shrink-0',
  status: 'w-24 shrink-0',
  actions: 'flex w-32 shrink-0 justify-end gap-1.5',
} as const

/**
 * Providers — a settings ledger: one row per provider with its key, last
 * use and whether it works, then Test and Edit; an unset provider reads
 * `Set up`. Edit opens that provider's fields under its row, one provider
 * at a time.
 */
function ProvidersGroup({ providers }: { providers: ProviderRow[] }) {
  const [open, setOpen] = useState<LlmProvider | null>(null)
  return (
    <div id={PROVIDERS_ANCHOR} className="flex scroll-mt-6 flex-col">
      <SettingsGroupHead
        title="Providers"
        action={`${providers.filter((p) => p.configured).length} of ${providers.length} set up`}
      />
      <div className="flex h-8 items-center gap-3 border-b border-hairline text-label text-graphite">
        <span className="min-w-0 flex-1">Provider</span>
        <span className={LANE.key}>Key</span>
        <span className={LANE.used}>Last used</span>
        <span className={LANE.status}>Status</span>
        <span className={LANE.actions} />
      </div>
      {providers.map((row) => (
        <ProviderLedgerRow
          key={row.provider}
          row={row}
          open={open === row.provider}
          onOpen={(next) => setOpen(next ? row.provider : null)}
        />
      ))}
    </div>
  )
}

function ProviderLedgerRow({
  row,
  open,
  onOpen,
}: {
  row: ProviderRow
  open: boolean
  onOpen: (open: boolean) => void
}) {
  const router = useRouter()
  const { now } = useClock()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  async function test() {
    setPending(true)
    setResult(null)
    try {
      const r = await testAiProvider({ data: { provider: row.provider } })
      setResult(r)
      void router.invalidate()
    } catch (err) {
      setResult({
        ok: false,
        status: null,
        message: err instanceof Error ? err.message : 'The test did not run',
      })
    } finally {
      setPending(false)
    }
  }

  const status = statusOf(row)
  return (
    <div
      data-provider={row.provider}
      className={cn(
        'flex flex-col border-b border-rule',
        open && '-mx-3 bg-bone px-3',
      )}
    >
      <div className="flex h-ledger-row items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <PluginMark name={row.label} offered={!row.configured} />
          <span
            className={cn(
              'truncate text-ui',
              row.configured ? 'font-medium text-foreground' : 'text-graphite',
            )}
          >
            {row.label}
          </span>
          {isLocalProvider(row.provider) ? (
            <span className="shrink-0 mono text-micro text-graphite">
              local
            </span>
          ) : null}
        </span>
        <span className={cn(LANE.key, 'truncate mono text-micro')}>
          {keyText(row)}
        </span>
        <span className={cn(LANE.used, 'mono text-micro text-graphite')}>
          {stamp(row.lastUsedAt, now)}
        </span>
        <span className={cn(LANE.status, 'flex items-center gap-1.5')}>
          {status.tone === 'none' ? null : (
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0',
                status.tone === 'ok' ? 'bg-primary' : 'bg-destructive',
              )}
            />
          )}
          <span
            className={cn(
              'truncate mono text-micro',
              status.tone === 'ok'
                ? 'text-primary'
                : status.tone === 'bad'
                  ? 'text-destructive'
                  : 'text-graphite',
            )}
          >
            {status.word}
          </span>
        </span>
        <span className={LANE.actions}>
          {row.configured ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void test()}
              disabled={pending}
              title="Sends one short prompt; its answer is not stored."
            >
              {pending ? 'Testing' : 'Test'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            aria-expanded={open}
            aria-label={`${open ? 'Close' : row.configured ? 'Edit' : 'Set up'} ${row.label}`}
            onClick={() => onOpen(!open)}
          >
            {open ? 'Close' : row.configured ? 'Edit' : 'Set up'}
          </Button>
        </span>
      </div>
      {open ? (
        <ProviderFields row={row} result={result} />
      ) : result ? (
        <TestLine result={result} />
      ) : null}
    </div>
  )
}

/** A Test call's answer or error, in one mono line. */
function TestLine({ result }: { result: TestResult }) {
  return (
    <p
      role="status"
      className={cn(
        'flex min-w-0 flex-1 items-start gap-2 py-2 mono text-micro break-words',
        result.ok ? 'text-graphite' : 'text-destructive',
      )}
    >
      {result.ok ? null : (
        <span aria-hidden className="mt-1 size-1.5 shrink-0 bg-destructive" />
      )}
      <span className="min-w-0">
        {result.ok
          ? `answered · ${result.text}`
          : `${result.status ? `error ${result.status} · ` : ''}${result.message}`}
      </span>
    </p>
  )
}

/**
 * One provider opened: key, base URL and extra headers as one draft in the
 * page's Save bar, then its Test with the answer or error inline. The key
 * settles empty after a save: it is write-only, and the row reads the
 * redacted display.
 */
function ProviderFields({
  row,
  result,
}: {
  row: ProviderRow
  result: TestResult | null
}) {
  const descriptor = PROVIDERS[row.provider]
  const router = useRouter()
  const { draft, set } = useSettingsDraft(
    {
      key: '',
      baseUrl: row.baseUrl ?? '',
      headers: formatHeaderLines(row.headers),
    },
    async (next) => {
      const key = next.key.trim()
      if (!descriptor.keyless && !row.configured && key === '')
        throw new Error(`Paste a ${row.label} key.`)
      const { display } = await saveAiKey({
        data: {
          provider: row.provider,
          ...(key === '' ? {} : { key }),
          baseUrl: next.baseUrl.trim(),
          headers: next.headers,
        },
      })
      toast(
        display ? `${row.label} key saved · ${display}` : `${row.label} saved`,
      )
      void router.invalidate()
      return { ...next, key: '' }
    },
  )

  const id = `ai-${row.provider}`
  return (
    <div className="flex flex-col pb-1 pl-7">
      {descriptor.keyless ? null : (
        <SettingsRow label={row.configured ? 'Replace key' : 'Key'}>
          <Input
            id={`${id}-key`}
            aria-label={`${row.label} API key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft.key}
            onChange={(e) => set('key', e.target.value)}
            placeholder={
              row.configured ? '••••••••' : descriptor.keyPlaceholder
            }
            className="w-64 mono"
          />
        </SettingsRow>
      )}
      <SettingsRow
        label={descriptor.keyless ? `${row.label} address` : 'Base URL'}
      >
        <SettingsTip
          tip={
            descriptor.keyless
              ? `Where ${row.label} listens. No key is needed; empty is ${descriptor.defaultBaseUrl}.`
              : "Optional. Point the provider at a gateway you run; empty is the provider's own."
          }
        >
          <Input
            id={`${id}-base-url`}
            aria-label={`${row.label} base URL`}
            type="url"
            value={draft.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            placeholder={descriptor.defaultBaseUrl}
            className="w-64 mono"
          />
        </SettingsTip>
      </SettingsRow>
      <SettingsRow
        label="Extra headers"
        hint="Stored as config, not encrypted."
      >
        <textarea
          id={`${id}-headers`}
          aria-label={`${row.label} extra headers`}
          rows={2}
          spellCheck={false}
          value={draft.headers}
          onChange={(e) => set('headers', e.target.value)}
          placeholder="Name: value"
          className="focus-ring w-64 rounded-md border border-rule bg-paper px-2.5 py-1.5 mono text-label outline-none placeholder:text-graphite"
        />
      </SettingsRow>
      {result ? <TestLine result={result} /> : null}
    </div>
  )
}

/** Each lane as a job: what it does in words, then its lane name in mono. */
const LANE_JOB: Record<AiLane, string> = {
  extract: 'Read documents',
  classify: 'Sort',
  synthesize: 'Write',
  embed: 'Embed',
  vision: 'Read images',
  research: 'Web research',
}

const SENSITIVITY_COLUMN: Record<AiSensitivity, string> = {
  normal: 'Everyday records',
  sensitive: 'Sensitive records',
}

/** The Off row's value; no provider id is this word. */
const UNSET = 'unset'
type CellValue = LlmProvider | typeof UNSET

/**
 * Who does what — the lane × sensitivity grid as a settings ledger:
 * one row per job, then one `Select` per sensitivity. Everyday cells list
 * every provider holding an active credential; sensitive cells list the
 * local ones only. A cell saves when it is chosen. The sensitivities are
 * `AI_SENSITIVITIES`, iterated: the grid reads the axis and never defines it.
 */
function RoutingGroup({
  providers,
  routes,
  embeddingPin,
}: {
  providers: ProviderRow[]
  routes: RouteRow[]
  embeddingPin: EmbeddingPin
}) {
  const routable = providers.filter(
    (p) => p.configured && p.status === 'active',
  )
  const cellOf = (lane: AiLane, sensitivity: AiSensitivity) =>
    routes.find((r) => r.lane === lane && r.sensitivity === sensitivity)
      ?.target ?? null
  const routed = routes.filter(
    (r) =>
      MODELS_GRID_LANES.some((lane) => lane === r.lane) &&
      routable.some((p) => p.provider === r.target?.provider),
  ).length

  // With no provider every cell could only read Off: the grid is one row
  // pointing at Providers instead.
  if (routable.length === 0)
    return (
      <div data-routing-collapsed className="flex flex-col pt-7">
        <div className="flex h-ledger-row items-center gap-6 border-y border-hairline">
          <span className="w-[13.125rem] shrink-0 text-ui font-medium">
            Who does what
          </span>
          <a
            href={`#${PROVIDERS_ANCHOR}`}
            className="focus-ring rounded-md text-ui text-foreground underline-offset-2 hover:underline"
          >
            Set up a provider ›
          </a>
        </div>
      </div>
    )

  return (
    <div className="flex flex-col">
      <SettingsGroupHead
        title="Who does what"
        count={`${routed} of ${MODELS_GRID_LANES.length * AI_SENSITIVITIES.length} set`}
        action="sensitive lists local models only"
      />
      <div className="flex h-8 items-center gap-3 border-b border-hairline text-label text-graphite">
        <span className="min-w-0 flex-1">Job</span>
        {AI_SENSITIVITIES.map((s) => (
          <span key={s} className="w-52 shrink-0">
            {SENSITIVITY_COLUMN[s]}
          </span>
        ))}
      </div>
      <ol>
        {MODELS_GRID_LANES.map((lane) => (
          <LedgerRow key={lane} className="px-0">
            <span className="flex min-w-0 flex-1 items-baseline truncate">
              <SettingsTip tip={<span className="mono">{lane}</span>}>
                <span
                  data-lane={lane}
                  tabIndex={0}
                  className="focus-ring rounded-md text-ui font-medium"
                >
                  {LANE_JOB[lane]}
                </span>
              </SettingsTip>
            </span>
            {AI_SENSITIVITIES.map((sensitivity) => (
              <RouteCellSelect
                key={sensitivity}
                lane={lane}
                sensitivity={sensitivity}
                stored={cellOf(lane, sensitivity)}
                routable={
                  sensitivity === 'sensitive'
                    ? routable.filter((p) => isLocalProvider(p.provider))
                    : routable
                }
              />
            ))}
          </LedgerRow>
        ))}
        <LedgerRow className="px-0">
          <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
            Embeddings · {embeddingPin?.model ?? 'none'} ·{' '}
            <Link
              to="/settings/search"
              className="text-foreground underline-offset-2 hover:underline"
            >
              set in Search ›
            </Link>
          </span>
        </LedgerRow>
      </ol>
    </div>
  )
}

/**
 * One cell. The value is the stored provider while that provider still holds
 * an active credential, and nothing otherwise — a cell whose key was deleted
 * reads `Off` in graphite, the same as a cell never routed, rather than
 * naming a provider that cannot answer. Each provider row offers the model
 * already stored for it, or its descriptor's default.
 */
function RouteCellSelect({
  lane,
  sensitivity,
  stored,
  routable,
}: {
  lane: AiLane
  sensitivity: AiSensitivity
  stored: RouteRow['target']
  routable: ProviderRow[]
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  const live =
    stored !== null && routable.some((p) => p.provider === stored.provider)
      ? stored.provider
      : ''
  const modelFor = (provider: LlmProvider) =>
    stored?.provider === provider
      ? stored.model
      : PROVIDERS[provider].defaultModel

  const items: Array<SelectItem<CellValue>> = [
    { value: UNSET, label: 'Off' },
    ...routable.map((p) => ({
      value: p.provider,
      label: `${p.label} · ${modelFor(p.provider)}`,
    })),
  ]

  async function choose(value: CellValue) {
    if (value === (live || UNSET)) return
    setPending(true)
    try {
      if (value === UNSET) {
        await setAiRoute({ data: { lane, sensitivity, provider: null } })
        toast(`${LANE_JOB[lane]} · ${SENSITIVITY_COLUMN[sensitivity]} off`)
      } else {
        const model = modelFor(value)
        await setAiRoute({
          data: { lane, sensitivity, provider: value, model },
        })
        toast(
          `${LANE_JOB[lane]} · ${SENSITIVITY_COLUMN[sensitivity]} · ${PROVIDERS[value].label} ${model}`,
        )
      }
      void router.invalidate()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save the route',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Select<CellValue>
      value={live}
      onChange={(v) => void choose(v)}
      items={items}
      width="content"
      placeholder="Off"
      disabled={pending}
      aria-label={`${lane} lane, ${sensitivity}`}
      className="w-52 shrink-0"
    />
  )
}
