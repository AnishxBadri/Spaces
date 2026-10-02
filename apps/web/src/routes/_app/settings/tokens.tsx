import { createFileRoute, useRouter } from '@tanstack/react-router'
import { Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { createApiToken, listApiTokens, revokeApiToken } from '#/lib/server-fns'
import { API_SCOPES, API_SCOPE_HINTS } from '#/lib/tokens/scopes'
import type { ApiScope } from '#/lib/tokens/scopes'
import { cn } from '#/lib/utils'

type TokenRow = Awaited<ReturnType<typeof listApiTokens>>[number]
type Created = Awaited<ReturnType<typeof createApiToken>>

/**
 * Settings → API tokens (SPA-23, `docs/spec-ai-substrate.md` §5): the
 * per-user bearer tokens an assistant uses to reach the MCP endpoint at
 * `/api/mcp`. A token is its owner's — every tool call through it reads as
 * that person, canRead and all — so each member manages their own, and the
 * row is not admin-only. The plaintext is shown once, in the strip under the
 * form, straight from the create response; the ledger only ever has the
 * prefix. Revoke is final: a revoked token answers 401 from then on.
 *
 * The same token opens the external API at `/api/v1` (SPA-48) for what its
 * scopes allow, ticked here at mint time and fixed from then on. MCP reads
 * no scopes; a token with none still opens it, and at `/api/v1` answers
 * only `GET /api/v1/me`.
 */
export const Route = createFileRoute('/_app/settings/tokens')({
  loader: async () => ({ tokens: await listApiTokens() }),
  component: TokensRoute,
})

/** An ISO instant as the ledger prints it: `2026-09-23 14:02 UTC`, no locale. */
function stamp(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—'
}

function TokensRoute() {
  const { tokens } = Route.useLoaderData()
  const router = useRouter()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ReadonlyArray<ApiScope>>([])
  const [created, setCreated] = useState<Created | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Name the token — say where it will live.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const token = await createApiToken({
        data: { name: name.trim(), scopes: [...scopes] },
      })
      setCreated(token)
      setName('')
      setScopes([])
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create')
    } finally {
      setPending(false)
    }
  }

  async function revoke(row: TokenRow) {
    try {
      await revokeApiToken({ data: { id: row.id } })
      if (created?.id === row.id) setCreated(null)
      toast(`${row.name} revoked`)
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revoke')
    }
  }

  function toggleScope(scope: ApiScope, on: boolean) {
    setScopes((current) =>
      API_SCOPES.filter((s) => (s === scope ? on : current.includes(s))),
    )
  }

  const live = tokens.filter((t) => t.revokedAt === null).length

  return (
    <SettingsSection
      title="API tokens"
      blurb="Tokens that let your own assistant read Spaces as you, over MCP, for the scopes you tick."
      crumb="Data & AI"
    >
      <form onSubmit={create} className="flex flex-col">
        <SettingsRow
          label="New token"
          hint="Name it for where it will live — the assistant, the machine."
        >
          <span className="flex items-center gap-2">
            <Input
              id="api-token-name"
              aria-label="Token name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Claude Desktop · laptop"
              maxLength={80}
              className="w-60"
            />
            <Button type="submit" size="sm" disabled={pending}>
              Create
            </Button>
          </span>
        </SettingsRow>
        <SettingsRow
          label="Scopes"
          hint="What it may do at /api/v1. It still acts as you, never more."
        >
          <span className="flex flex-col">
            {API_SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex h-7 cursor-pointer items-center gap-2"
              >
                <Checkbox
                  checked={scopes.includes(scope)}
                  disabled={pending}
                  aria-label={scope}
                  onCheckedChange={(next) => toggleScope(scope, next)}
                />
                <span className="w-32 mono text-micro">{scope}</span>
                <span className="w-72 truncate text-label text-graphite">
                  {API_SCOPE_HINTS[scope]}
                </span>
              </label>
            ))}
          </span>
        </SettingsRow>
        {error ? (
          <p
            role="alert"
            className="border-b border-rule py-2 mono text-micro text-destructive"
          >
            {error}
          </p>
        ) : null}
      </form>

      {created ? <CreatedStrip created={created} /> : null}

      <div className="flex flex-col pt-5">
        <div className="flex items-baseline gap-3 pb-2">
          <h3 className="label-caps text-foreground">Your tokens</h3>
          <span className="mono text-micro text-graphite">
            {live} live · {tokens.length - live} revoked
          </span>
        </div>

        <div className="flex h-8 items-center border-y border-hairline field-label leading-4 text-graphite">
          <span className="min-w-0 flex-1">Name</span>
          <span className="w-32 shrink-0">Token</span>
          <span className="w-40 shrink-0">Scopes</span>
          <span className="w-40 shrink-0">Created</span>
          <span className="w-40 shrink-0">Last used</span>
          <span className="w-16 shrink-0" />
        </div>
        {tokens.length === 0 ? (
          <p className="border-b border-rule py-3 text-label text-graphite">
            None yet. Create one above and paste it into your assistant’s MCP
            settings.
          </p>
        ) : (
          tokens.map((t) => (
            <div
              key={t.id}
              className={cn(
                'flex h-9 items-center border-b border-rule',
                t.revokedAt && 'text-graphite',
              )}
            >
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-ui font-medium',
                  t.revokedAt && 'line-through',
                )}
              >
                {t.name}
              </span>
              <span className="w-32 shrink-0 mono text-label">{t.prefix}…</span>
              <span
                className="w-40 shrink-0 truncate mono text-micro text-graphite"
                title={t.scopes.join(', ')}
              >
                {t.scopes.length === 0 ? 'none' : t.scopes.join(' · ')}
              </span>
              <span className="w-40 shrink-0 mono text-micro text-graphite">
                {stamp(t.createdAt)}
              </span>
              <span className="w-40 shrink-0 mono text-micro text-graphite">
                {stamp(t.lastUsedAt)}
              </span>
              <span className="flex w-16 shrink-0 justify-end">
                {t.revokedAt ? (
                  <span className="mono text-micro text-graphite">revoked</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => revoke(t)}
                    className="focus-ring mono text-micro text-graphite hover:text-foreground"
                  >
                    revoke
                  </button>
                )}
              </span>
            </div>
          ))
        )}

        <div className="flex h-8 items-center justify-between">
          <span className="label-caps font-normal text-graphite">
            yours only · read as you
          </span>
          <span className="mono text-micro text-graphite">
            /api/mcp · /api/v1 · Authorization: Bearer &lt;token&gt;
          </span>
        </div>
      </div>
    </SettingsSection>
  )
}

/**
 * The one showing of a token's plaintext. It lives in component state from
 * the create response and goes when the page does; nothing can fetch it
 * again. The `claude mcp add` line is the copy-paste for Claude Code.
 */
function CreatedStrip({ created }: { created: Created }) {
  const endpoint = `${window.location.origin}/api/mcp`
  const command = `claude mcp add --transport http spaces ${endpoint} --header "Authorization: Bearer ${created.token}"`

  const copy = (value: string, what: string) => {
    navigator.clipboard.writeText(value).then(
      () => toast.success(`${what} copied`),
      () => toast.error('Could not copy — select it above'),
    )
  }

  return (
    <div
      role="status"
      className="mt-3 flex flex-col border border-rule bg-bone"
    >
      <div className="flex min-h-9 items-center gap-2 px-3 py-1">
        <span className="shrink-0 mono text-micro text-graphite">
          {created.name}
        </span>
        <code className="min-w-0 flex-1 truncate mono text-micro">
          {created.token}
        </code>
        <Button
          size="xs"
          variant="outline"
          onClick={() => copy(created.token, 'Token')}
        >
          <Copy className="size-3" strokeWidth={2} />
          Copy
        </Button>
      </div>
      <div className="flex min-h-9 items-center gap-2 border-t border-rule px-3 py-1">
        <span className="shrink-0 mono text-micro text-graphite">
          Claude Code
        </span>
        <code className="min-w-0 flex-1 truncate mono text-micro">
          {command}
        </code>
        <Button
          size="xs"
          variant="outline"
          onClick={() => copy(command, 'Command')}
        >
          <Copy className="size-3" strokeWidth={2} />
          Copy
        </Button>
      </div>
      <p className="border-t border-rule px-3 py-2 text-label text-graphite">
        Copy it now — this is the only time Spaces shows it. Lose it and you
        revoke it and make another.
      </p>
    </div>
  )
}
