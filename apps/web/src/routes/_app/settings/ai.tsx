import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { LedgerRow } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import type { SelectItem } from '#/components/ui/select'
import { AI_LANES, AI_SENSITIVITIES } from '#/lib/ai/lanes'
import type { AiLane, AiSensitivity } from '#/lib/ai/lanes'
import { PROVIDERS } from '#/lib/ai/providers/ids'
import type { LlmProvider } from '#/lib/ai/providers/ids'
import { formatHeaderLines } from '#/lib/ai/providers/meta'
import {
  getSession,
  listAiProviders,
  listAiRoutes,
  saveAiKey,
  setAiRoute,
  testAiProvider,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

type ProviderRow = Awaited<ReturnType<typeof listAiProviders>>[number]
type RouteRow = Awaited<ReturnType<typeof listAiRoutes>>[number]
type TestResult = Awaited<ReturnType<typeof testAiProvider>>

/**
 * Settings → AI → Providers (SPA-29, `docs/spec-ai-substrate.md` §9). The
 * vault's LLM keys, admin-only. Five providers (SPA-39), one row and one form
 * each, both drawn from the provider's descriptor (`PROVIDERS` in
 * `lib/ai/providers/ids.ts`) — what differs between providers is data there,
 * never a branch on the id here. The loader asks for the providers only when
 * the reader is an admin — the server fns refuse anyone else, and a member who
 * types the URL reads a sentence instead of an error.
 */
export const Route = createFileRoute('/_app/settings/ai')({
  loader: async () => {
    const session = await getSession()
    const isAdmin = session?.user.role === 'admin'
    if (!isAdmin) return { isAdmin, providers: [], routes: [] }
    const [providers, routes] = await Promise.all([
      listAiProviders(),
      listAiRoutes(),
    ])
    return { isAdmin, providers, routes }
  },
  component: AiRoute,
})

function AiRoute() {
  const { isAdmin, providers, routes } = Route.useLoaderData()
  return (
    <div className="flex flex-col gap-8">
      <ProvidersSection isAdmin={isAdmin} providers={providers} />
      {isAdmin ? (
        <RoutingSection providers={providers} routes={routes} />
      ) : null}
    </div>
  )
}

/** An ISO instant as the ledger prints it: `2026-09-23 14:02 UTC`, no locale. */
function stamp(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—'
}

function statusOf(row: ProviderRow): string {
  if (!row.configured) return 'none'
  if (row.lastTestOk === true) return 'test ok'
  if (row.lastTestOk === false) return 'test failed'
  return 'configured'
}

/**
 * Providers — a settings ledger in the FX-rates shape (design contract, "A
 * settings section"): a `field-label` head on hairlines, one 36px row per
 * provider with the Test action in its last lane, then the form that writes
 * the row. The key field is write-only: it starts empty every time and the
 * ledger shows only the redacted display.
 */
function ProvidersSection({
  isAdmin,
  providers,
}: {
  isAdmin: boolean
  providers: ProviderRow[]
}) {
  if (!isAdmin) {
    return (
      <SettingsSection
        title="AI providers"
        blurb="Which model providers this workspace calls, with whose key."
        crumb="Workspace"
      >
        <SettingsRow
          label="Admins only"
          hint="Provider keys belong to the workspace admin."
        />
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title="AI providers"
      blurb="Which model providers this workspace calls, with whose key. Keys are encrypted at rest and never shown again."
      crumb="Workspace"
    >
      <div className="flex flex-col pt-5">
        <div className="flex items-baseline gap-3 pb-2">
          <h3 className="label-caps text-foreground">Providers</h3>
          <span className="mono text-micro text-graphite">
            {providers.filter((p) => p.configured).length} of {providers.length}{' '}
            configured
          </span>
        </div>

        <div className="flex h-8 items-center border-y border-hairline field-label leading-4 text-graphite">
          <span className="w-28 shrink-0">Provider</span>
          <span className="w-24 shrink-0">Status</span>
          <span className="w-28 shrink-0">Key</span>
          <span className="w-40 shrink-0">Last used</span>
          <span className="min-w-0 flex-1">Base URL</span>
          <span className="w-16 shrink-0" />
        </div>
        {providers.map((row) => (
          <ProviderLedgerRow key={row.provider} row={row} />
        ))}

        {providers.map((row) => (
          <ProviderForm key={row.provider} row={row} />
        ))}

        <div className="flex h-8 items-center justify-between">
          <span className="label-caps font-normal text-graphite">
            workspace keys · admin only
          </span>
          <span className="mono text-micro text-graphite">
            a test sends one short prompt · its answer is not stored
          </span>
        </div>
      </div>
    </SettingsSection>
  )
}

/** The Key lane: the redacted display, or what stands in for one. */
function keyText(row: ProviderRow): string {
  if (row.display) return row.display
  if (PROVIDERS[row.provider].keyless && row.configured) return 'no key'
  return '—'
}

function ProviderLedgerRow({ row }: { row: ProviderRow }) {
  const router = useRouter()
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
    <>
      <div className="flex h-9 items-center border-b border-rule">
        <span className="w-28 shrink-0 text-ui font-medium">{row.label}</span>
        <span
          className={cn(
            'w-24 shrink-0 mono text-micro',
            status === 'test failed' ? 'text-destructive' : 'text-graphite',
          )}
        >
          {status}
        </span>
        <span className="w-28 shrink-0 mono text-label">{keyText(row)}</span>
        <span className="w-40 shrink-0 mono text-micro text-graphite">
          {stamp(row.lastUsedAt)}
        </span>
        <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
          {row.baseUrl ?? 'default'}
          {Object.keys(row.headers).length > 0
            ? ` · ${Object.keys(row.headers).length} header${Object.keys(row.headers).length === 1 ? '' : 's'}`
            : ''}
        </span>
        <span className="flex w-16 shrink-0 justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={test}
            disabled={pending || !row.configured}
          >
            {pending ? 'Testing' : 'Test'}
          </Button>
        </span>
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
              ? 'answer'
              : result.status
                ? `error ${result.status}`
                : 'error'}
          </span>
          <span className="min-w-0 flex-1 mono text-label break-words">
            {result.ok ? result.text : result.message}
          </span>
        </div>
      ) : null}
    </>
  )
}

function ProviderForm({ row }: { row: ProviderRow }) {
  const descriptor = PROVIDERS[row.provider]
  const router = useRouter()
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(row.baseUrl ?? '')
  const [headers, setHeaders] = useState(formatHeaderLines(row.headers))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!descriptor.keyless && !row.configured && !key.trim()) {
      setError(`Paste a ${row.label} key.`)
      return
    }
    setPending(true)
    setError(null)
    try {
      const { display } = await saveAiKey({
        data: {
          provider: row.provider,
          ...(key.trim() ? { key: key.trim() } : {}),
          baseUrl: baseUrl.trim(),
          headers,
        },
      })
      // The field empties: the key is write-only, and what is shown from
      // here on is the redacted display the ledger row reads.
      setKey('')
      toast(
        display ? `${row.label} key saved · ${display}` : `${row.label} saved`,
      )
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  const id = `ai-${row.provider}`
  return (
    <form onSubmit={save} className="flex flex-col">
      {descriptor.keyless ? null : (
        <SettingsRow
          label={
            row.configured ? `Replace ${row.label} key` : `${row.label} key`
          }
          hint={
            row.configured
              ? `Saved as ${row.display ?? '••••'}. Leave empty to keep it.`
              : 'Stored encrypted as the workspace key.'
          }
        >
          <Input
            id={`${id}-key`}
            aria-label={`${row.label} API key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              row.configured ? '••••••••' : descriptor.keyPlaceholder
            }
            className="w-72 mono"
          />
        </SettingsRow>
      )}
      <SettingsRow
        label={descriptor.keyless ? `${row.label} base URL` : 'Base URL'}
        hint={
          descriptor.keyless
            ? `Where ${row.label} listens. No key is needed; empty is ${descriptor.defaultBaseUrl}.`
            : "Optional. Point the provider at a gateway you run; empty is the provider's own."
        }
      >
        <Input
          id={`${id}-base-url`}
          aria-label={`${row.label} base URL`}
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={descriptor.defaultBaseUrl}
          className="w-72 mono"
        />
      </SettingsRow>
      <SettingsRow
        label="Extra headers"
        hint="Optional. One per line, Name: value. Stored as config, not encrypted."
      >
        <textarea
          id={`${id}-headers`}
          aria-label={`${row.label} extra headers`}
          rows={2}
          spellCheck={false}
          value={headers}
          onChange={(e) => setHeaders(e.target.value)}
          placeholder="Helicone-Cache-Enabled: true"
          className="focus-ring w-72 rounded-md border border-rule bg-paper px-2.5 py-1.5 mono text-label outline-none placeholder:text-graphite"
        />
      </SettingsRow>
      <div className="flex min-h-12 items-center justify-end gap-3 border-b border-rule py-2">
        {error ? (
          <span
            role="alert"
            className="mr-auto mono text-micro text-destructive"
          >
            {error}
          </span>
        ) : null}
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  )
}

/** What each lane does, one line — keyed by the lane union, so none is missed. */
const LANE_ROLE: Record<AiLane, string> = {
  extract: 'Reads a document into fields — a deck into the company record.',
  classify: 'Picks a value from a fixed list — a document’s kind.',
  synthesize: 'Drafts memos, analyses and summaries.',
  embed: 'Turns text into vectors for search.',
  vision: 'Reads pages a text extractor cannot — scans and images.',
  research: 'Looks things up on the live web.',
}

/** The Unset row's value; no provider id is this word. */
const UNSET = 'unset'
type CellValue = LlmProvider | typeof UNSET

/**
 * Routing (SPA-69, `docs/spec-ai-substrate.md` §9) — the lane × sensitivity
 * table as a settings ledger (D20, Option 1): one 36px row per lane, the
 * lane's name and what it does left, then one fixed lane per sensitivity,
 * each a `Select` of the providers holding an active credential. The
 * sensitivity lanes are `AI_SENSITIVITIES`, iterated: the grid reads the axis
 * and never defines it, and the copy line says where a record or a space is
 * actually marked sensitive.
 */
function RoutingSection({
  providers,
  routes,
}: {
  providers: ProviderRow[]
  routes: RouteRow[]
}) {
  const routable = providers.filter(
    (p) => p.configured && p.status === 'active',
  )
  const cellOf = (lane: AiLane, sensitivity: AiSensitivity) =>
    routes.find((r) => r.lane === lane && r.sensitivity === sensitivity)
      ?.target ?? null
  const routed = routes.filter((r) =>
    routable.some((p) => p.provider === r.target?.provider),
  ).length

  return (
    <SettingsSection
      title="Routing"
      blurb="Which provider and model each lane calls, at each sensitivity."
      crumb="Workspace"
    >
      <div className="flex flex-col pt-5">
        <div className="flex items-baseline gap-3 pb-2">
          <h3 className="label-caps text-foreground">Lanes</h3>
          <span className="mono text-micro text-graphite">
            {routed} of {AI_LANES.length * AI_SENSITIVITIES.length} routed
          </span>
        </div>
        <p className="pb-3 text-label text-graphite">
          A lane with no model routed hides the features that use it. Sensitive
          routes must be local (Ollama). Records and spaces are marked sensitive
          on their own pages, not here.
        </p>

        <div className="flex h-8 items-center gap-3 border-y border-hairline field-label leading-4 text-graphite">
          <span className="w-24 shrink-0">Lane</span>
          <span className="min-w-0 flex-1" />
          {AI_SENSITIVITIES.map((s) => (
            <span key={s} className="w-56 shrink-0">
              {s}
            </span>
          ))}
        </div>
        <ol>
          {AI_LANES.map((lane) => (
            <LedgerRow key={lane}>
              <span className="w-24 shrink-0 text-ui font-medium capitalize">
                {lane}
              </span>
              <span className="min-w-0 flex-1 truncate text-label text-graphite">
                {LANE_ROLE[lane]}
              </span>
              {AI_SENSITIVITIES.map((sensitivity) => (
                <RouteCellSelect
                  key={sensitivity}
                  lane={lane}
                  sensitivity={sensitivity}
                  stored={cellOf(lane, sensitivity)}
                  routable={routable}
                />
              ))}
            </LedgerRow>
          ))}
        </ol>

        <div className="flex h-8 items-center justify-between">
          <span className="label-caps font-normal text-graphite">
            lane × sensitivity · admin only
          </span>
          <span className="mono text-micro text-graphite">
            only providers with a saved key are listed
          </span>
        </div>
      </div>
    </SettingsSection>
  )
}

/**
 * One cell. The value is the stored provider while that provider still holds
 * an active credential, and nothing otherwise — a cell whose key was deleted
 * reads `— unset` in graphite, the same as a cell never routed, rather than
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
    { value: UNSET, label: 'Unset' },
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
        toast(`${lane} · ${sensitivity} unset`)
      } else {
        const model = modelFor(value)
        await setAiRoute({
          data: { lane, sensitivity, provider: value, model },
        })
        toast(`${lane} · ${sensitivity} · ${PROVIDERS[value].label} ${model}`)
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
      placeholder="— unset"
      disabled={pending}
      aria-label={`${lane} lane, ${sensitivity}`}
      className="w-56 shrink-0"
    />
  )
}
