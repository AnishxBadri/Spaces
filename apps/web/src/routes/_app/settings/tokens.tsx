import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyRow } from '#/components/ledger-section'
import {
  SettingsGroupHead,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { MoreMenu } from '#/components/ui/more-menu'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { createApiToken, listApiTokens, revokeApiToken } from '#/lib/server-fns'
import {
  API_SCOPE_HINTS,
  API_SCOPE_WORDS,
  isApiScope,
} from '#/lib/tokens/scopes'
import type { ApiScope } from '#/lib/tokens/scopes'
import { formatFullDay, formatTime, formatWhen } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

type TokenRow = Awaited<ReturnType<typeof listApiTokens>>[number]
type Created = Awaited<ReturnType<typeof createApiToken>>

/**
 * Settings → API tokens: the per-user bearer tokens an assistant uses to
 * reach `/api/mcp`, and the external API at `/api/v1` for what their scopes
 * allow.
 * - A token is its owner's: every call through it reads as that person,
 *   canRead and all, so each member manages their own.
 * - `New token` in the head opens a window; the plaintext is shown once, in
 *   that window, straight from the create response. The ledger only ever
 *   has the prefix.
 * - Scopes are ticked at mint time and fixed. MCP reads none; a token with
 *   none still opens it, and at `/api/v1` answers only `GET /api/v1/me`.
 * - Revoke is final and asks first.
 */
export const Route = createFileRoute('/_app/settings/tokens')({
  loader: async () => ({ tokens: await listApiTokens() }),
  component: TokensRoute,
})

/** The order the window offers scopes in: reading first, then writing. */
const OFFERED: ReadonlyArray<ApiScope> = [
  'records:read',
  'suggestions:write',
  'capture:write',
]

/** A cell's title: the whole instant, `4 Oct 2026 14:02`. */
const stamp = (iso: string) => `${formatFullDay(iso)} ${formatTime(iso)}`

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
  const { now } = useClock()
  // A ledger day: the time today, else the day; the cell's title is whole.
  const day = (iso: string) => formatWhen(iso, now)
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  async function revoke(row: TokenRow) {
    const ok = await confirm({
      title: `Revoke ${row.name}?`,
      body: 'Anything using it stops at once. It cannot come back; make a new one if you need it.',
      action: 'Revoke',
    })
    if (!ok) return
    try {
      await revokeApiToken({ data: { id: row.id } })
      toast(`${row.name} revoked`)
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revoke')
    }
  }

  const live = tokens.filter((t) => t.revokedAt === null).length

  return (
    <SettingsSection
      title="API tokens"
      crumb="You"
      action={
        <Button variant="outline" onClick={() => setCreating(true)}>
          New token
        </Button>
      }
    >
      {tokens.length === 0 ? (
        <div className="flex flex-col pt-7">
          <EmptyRow name="Tokens" onAdd={() => setCreating(true)} />
        </div>
      ) : (
        <div className="flex flex-col">
          <SettingsGroupHead
            title="Your tokens"
            count={`${live} live · ${tokens.length - live} revoked`}
          />
          <div className="flex h-8 items-center gap-3 border-b border-hairline text-label text-graphite">
            <span className="min-w-0 flex-1">Name</span>
            <span className="w-32 shrink-0">It may</span>
            <span className="w-16 shrink-0">Created</span>
            <span className="w-28 shrink-0">Last used</span>
            <span className="w-16 shrink-0" />
          </div>
          {tokens.map((t) => (
            <div
              key={t.id}
              data-token-row
              data-row
              {...(t.revokedAt ? { 'data-revoked': '' } : {})}
              className={cn(
                'flex h-10 items-center gap-3 border-b border-rule',
                t.revokedAt && 'text-graphite line-through',
              )}
            >
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-ui',
                  t.revokedAt === null && 'font-medium',
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
                {...(t.revokedAt
                  ? { title: stamp(t.revokedAt) }
                  : t.lastUsedAt
                    ? { title: stamp(t.lastUsedAt) }
                    : {})}
              >
                {t.revokedAt
                  ? `Revoked ${day(t.revokedAt)}`
                  : t.lastUsedAt
                    ? day(t.lastUsedAt)
                    : '—'}
              </span>
              <span className="flex w-16 shrink-0 justify-end">
                {t.revokedAt ? null : (
                  <MoreMenu
                    variant="row"
                    label={t.name}
                    items={[
                      {
                        label: 'Revoke…',
                        destructive: true,
                        opens: true,
                        onSelect: () => void revoke(t),
                      },
                    ]}
                  />
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <NewTokenDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => void router.invalidate()}
      />
      {confirmDialog}
    </SettingsSection>
  )
}

/**
 * The New token window (S): the name, then what the token may do — each
 * scope a sentence with its mono id under it — then `Create token`. Once
 * created the window swaps to the one showing of the plaintext, closed by
 * `Done`; closing forgets it.
 */
function NewTokenDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ReadonlyArray<ApiScope>>([])
  const [created, setCreated] = useState<Created | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  function change(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setName('')
      setScopes([])
      setCreated(null)
      setError(null)
    }
  }

  function toggleScope(scope: ApiScope, on: boolean) {
    setScopes((current) =>
      OFFERED.filter((s) => (s === scope ? on : current.includes(s))),
    )
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
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
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New token</DialogTitle>
        </DialogHeader>
        {created === null ? (
          <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="api-token-name">Name</Label>
              <Input
                id="api-token-name"
                aria-label="Token name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Claude Desktop · laptop"
                maxLength={80}
              />
            </div>
            <div
              role="group"
              aria-labelledby="api-token-may"
              className="flex flex-col gap-2"
            >
              <div className="flex flex-col gap-0.5">
                <span id="api-token-may" className="text-label text-graphite">
                  It may
                </span>
                <span data-token-may-line className="text-ui">
                  It acts as you, never more.
                </span>
              </div>
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
                    <span className="mono text-micro text-graphite">
                      {scope}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {error ? (
              <p role="alert" className="text-ui text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending ? 'Creating…' : 'Create token'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col">
            <CreatedPanel created={created} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Done
                </Button>
              </DialogClose>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The one showing of a token's plaintext. It lives in the window's state
 * from the create response and goes when the window closes; nothing can
 * fetch it again. The `claude mcp add` line is the copy-paste for Claude
 * Code.
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
