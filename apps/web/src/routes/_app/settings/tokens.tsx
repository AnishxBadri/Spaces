import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsRowMenu,
  SettingsSection,
  SettingsTip,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { DropdownMenuItem } from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { createApiToken, listApiTokens, revokeApiToken } from '#/lib/server-fns'
import {
  API_SCOPE_HINTS,
  API_SCOPE_WORDS,
  isApiScope,
} from '#/lib/tokens/scopes'
import type { ApiScope } from '#/lib/tokens/scopes'
import { cn } from '#/lib/utils'

type TokenRow = Awaited<ReturnType<typeof listApiTokens>>[number]
type Created = Awaited<ReturnType<typeof createApiToken>>

/**
 * Settings → API tokens: the per-user bearer tokens an assistant uses to
 * reach `/api/mcp`, and the external API at `/api/v1` for what their scopes
 * allow.
 * - A token is its owner's: every call through it reads as that person,
 *   canRead and all, so each member manages their own.
 * - The plaintext is shown once, in the panel under the form, straight from
 *   the create response; the ledger only ever has the prefix.
 * - Scopes are ticked at mint time and fixed. MCP reads none; a token with
 *   none still opens it, and at `/api/v1` answers only `GET /api/v1/me`.
 * - Revoke is final and asks first.
 */
export const Route = createFileRoute('/_app/settings/tokens')({
  loader: async () => ({ tokens: await listApiTokens() }),
  component: TokensRoute,
})

/** The order the form offers scopes in: reading first, then writing. */
const OFFERED: ReadonlyArray<ApiScope> = [
  'records:read',
  'suggestions:write',
  'capture:write',
]

/** A ledger day: `today`, else `MM-DD`; the full instant is the cell's title. */
function day(iso: string): string {
  return iso.slice(0, 10) === new Date().toISOString().slice(0, 10)
    ? 'today'
    : iso.slice(5, 10)
}

const stamp = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`

/** What a token may do, in words: `Read, Propose`. */
function mayWords(scopes: ReadonlyArray<string>): string {
  const words = OFFERED.filter((s) => scopes.includes(s)).map(
    (s) => API_SCOPE_WORDS[s],
  )
  const unknown = scopes.filter((s) => !isApiScope(s))
  return [...words, ...unknown].join(', ') || '—'
}

function TokensRoute() {
  const { tokens } = Route.useLoaderData()
  const router = useRouter()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ReadonlyArray<ApiScope>>([])
  const [created, setCreated] = useState<Created | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

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
    const ok = await confirm({
      title: `Revoke ${row.name}?`,
      body: 'Anything using it stops at once. It cannot come back; make a new one if you need it.',
      action: 'Revoke',
    })
    if (!ok) return
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
      OFFERED.filter((s) => (s === scope ? on : current.includes(s))),
    )
  }

  const live = tokens.filter((t) => t.revokedAt === null).length

  return (
    <SettingsSection title="API tokens" crumb="You">
      <form onSubmit={create} className="flex flex-col">
        <SettingsGroupHead title="New token" />
        <SettingsRow label="Name">
          <SettingsTip tip="Name it for where it will live — the assistant, the machine.">
            <Input
              id="api-token-name"
              aria-label="Token name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Claude Desktop · laptop"
              maxLength={80}
              className="w-64"
            />
          </SettingsTip>
        </SettingsRow>
        <SettingsRow label="It may" hint="It acts as you, never more.">
          <span className="flex flex-col gap-2 py-1">
            {OFFERED.map((scope) => (
              <label
                key={scope}
                className="flex cursor-pointer items-start gap-2"
              >
                <Checkbox
                  checked={scopes.includes(scope)}
                  disabled={pending}
                  aria-label={API_SCOPE_HINTS[scope]}
                  onCheckedChange={(next) => toggleScope(scope, next)}
                  className="mt-0.5"
                />
                <span className="flex flex-col">
                  <span className="text-ui">{API_SCOPE_HINTS[scope]}</span>
                  <span className="mono text-micro text-graphite">{scope}</span>
                </span>
              </label>
            ))}
          </span>
        </SettingsRow>
        <div className="flex min-h-12 items-center justify-end gap-3 py-2">
          {error ? (
            <p
              role="alert"
              className="min-w-0 flex-1 mono text-micro text-destructive"
            >
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={pending}>
            Create token
          </Button>
        </div>
      </form>

      {created ? <CreatedPanel created={created} /> : null}

      <div className="flex flex-col">
        <SettingsGroupHead
          title="Your tokens"
          count={`${live} live · ${tokens.length - live} revoked`}
        />
        <div className="flex h-8 items-center gap-3 border-b border-hairline field-label leading-4 text-graphite">
          <span className="min-w-0 flex-1">Name</span>
          <span className="w-32 shrink-0">It may</span>
          <span className="w-16 shrink-0">Created</span>
          <span className="w-28 shrink-0">Last used</span>
          <span className="w-6 shrink-0" />
        </div>
        {tokens.length === 0 ? (
          <p className="border-b border-rule py-3 text-label text-graphite">
            No tokens.
          </p>
        ) : (
          tokens.map((t) => (
            <div
              key={t.id}
              data-token-row
              className={cn(
                'flex h-10 items-center gap-3 border-b border-rule',
                t.revokedAt && 'text-graphite',
              )}
            >
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-ui',
                  t.revokedAt ? 'line-through' : 'font-medium',
                )}
                title={`${t.prefix}…`}
              >
                {t.name}
              </span>
              <span className="w-32 shrink-0 truncate text-label">
                {mayWords(t.scopes)}
              </span>
              <span
                className="w-16 shrink-0 mono text-micro text-graphite"
                title={stamp(t.createdAt)}
              >
                {day(t.createdAt)}
              </span>
              <span
                className="w-28 shrink-0 truncate mono text-micro text-graphite"
                {...(t.lastUsedAt ? { title: stamp(t.lastUsedAt) } : {})}
              >
                {t.revokedAt
                  ? `revoked ${day(t.revokedAt)}`
                  : t.lastUsedAt
                    ? day(t.lastUsedAt)
                    : '—'}
              </span>
              <span className="flex w-6 shrink-0 justify-end">
                {t.revokedAt ? null : (
                  <SettingsRowMenu label={t.name}>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => void revoke(t)}
                    >
                      Revoke…
                    </DropdownMenuItem>
                  </SettingsRowMenu>
                )}
              </span>
            </div>
          ))
        )}
      </div>
      {confirmDialog}
    </SettingsSection>
  )
}

/**
 * The one showing of a token's plaintext. It lives in component state from
 * the create response and goes when the page does; nothing can fetch it
 * again. The `claude mcp add` line is the copy-paste for Claude Code.
 */
function CreatedPanel({ created }: { created: Created }) {
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
      data-created-token
      className="flex flex-col gap-2.5 border border-hairline bg-bone px-4 py-3.5"
    >
      <p className="text-ui">Copy it now. Spaces shows it once.</p>
      <div className="flex items-center gap-3">
        <code className="min-w-0 flex-1 truncate mono text-micro select-all">
          {created.token}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => copy(created.token, 'Token')}
        >
          Copy
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <code className="min-w-0 flex-1 truncate mono text-micro select-all">
          {command}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => copy(command, 'Command')}
        >
          Copy command
        </Button>
      </div>
    </div>
  )
}
