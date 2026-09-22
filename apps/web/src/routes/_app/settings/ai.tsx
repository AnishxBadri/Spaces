import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { formatHeaderLines } from '#/lib/ai/providers/meta'
import {
  getSession,
  listAiProviders,
  saveAiKey,
  testAiProvider,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

type ProviderRow = Awaited<ReturnType<typeof listAiProviders>>[number]
type TestResult = Awaited<ReturnType<typeof testAiProvider>>

/**
 * Settings → AI → Providers (SPA-29, `docs/spec-ai-substrate.md` §9). The
 * vault's LLM keys, admin-only. The loader asks for the providers only when
 * the reader is an admin — the server fns refuse anyone else, and a member who
 * types the URL reads a sentence instead of an error.
 */
export const Route = createFileRoute('/_app/settings/ai')({
  loader: async () => {
    const session = await getSession()
    const isAdmin = session?.user.role === 'admin'
    return { isAdmin, providers: isAdmin ? await listAiProviders() : [] }
  },
  component: AiRoute,
})

function AiRoute() {
  const { isAdmin, providers } = Route.useLoaderData()
  return <ProvidersSection isAdmin={isAdmin} providers={providers} />
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
        <span className="w-28 shrink-0 mono text-label">
          {row.display ?? '—'}
        </span>
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
  const router = useRouter()
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(row.baseUrl ?? '')
  const [headers, setHeaders] = useState(formatHeaderLines(row.headers))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!row.configured && !key.trim()) {
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
      toast(display ? `${row.label} key saved · ${display}` : 'Saved')
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
      <SettingsRow
        label={row.configured ? `Replace ${row.label} key` : `${row.label} key`}
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
          placeholder={row.configured ? '••••••••' : 'sk-ant-…'}
          className="w-72 mono"
        />
      </SettingsRow>
      <SettingsRow
        label="Base URL"
        hint="Optional. Point the provider at a gateway you run; empty is the provider's own."
      >
        <Input
          id={`${id}-base-url`}
          aria-label={`${row.label} base URL`}
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.anthropic.com/v1"
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
