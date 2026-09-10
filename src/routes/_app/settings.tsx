import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ChevronRight, Copy, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ObjectDialog } from '#/components/objects/object-dialog'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  createInvite,
  getSession,
  getWorkspace,
  listInvites,
  listMembers,
  listFxRates,
  listObjects,
  updateObject,
  listTemplates,
  revokeInvite,
  saveWorkspace,
  setBaseCurrency,
  setFxRate,
  setMemberBanned,
  setMemberRole,
  updateTemplate,
} from '#/lib/server-fns'
import { objectIcon } from '#/lib/object-icons'
import { cn } from '#/lib/utils'

/**
 * Settings: the workspace singleton, members + invites, and the attribute
 * registries behind Companies, People, Deals. Structure fixed, content
 * free; admin owns the destructive edges.
 */
export const Route = createFileRoute('/_app/settings')({
  loader: async () => {
    const [session, workspace, members, templates, objects, fx] =
      await Promise.all([
        getSession(),
        getWorkspace(),
        listMembers(),
        listTemplates({ data: { includeArchived: true } }),
        listObjects({ data: { includeArchived: true } }),
        listFxRates(),
      ])
    const isAdmin = session?.user.role === 'admin'
    const invites = isAdmin ? await listInvites() : []
    return {
      me: session!.user,
      isAdmin,
      workspace,
      members,
      templates,
      invites,
      objects,
      fx,
    }
  },
  component: SettingsPage,
})

type ObjectRow = Awaited<ReturnType<typeof listObjects>>[number]

function SettingsPage() {
  const data = Route.useLoaderData()

  return (
    <div className="mx-auto w-full max-w-column px-6 py-8 md:px-10">
      <header>
        <h1 className="title-serif">Settings</h1>
        <p className="mt-1 text-ui text-muted-foreground">
          Workspace, members, and objects. Structural edits are admin-only.
        </p>
      </header>

      <WorkspaceSection
        name={data.workspace?.name ?? ''}
        isAdmin={data.isAdmin}
      />

      <MembersSection
        me={data.me}
        isAdmin={data.isAdmin}
        members={data.members}
        invites={data.invites}
      />

      <TemplatesSection templates={data.templates} />

      <FxSection
        isAdmin={data.isAdmin}
        baseCurrency={data.fx.baseCurrency}
        rates={data.fx.rates}
      />

      <ObjectsSection objects={data.objects} isAdmin={data.isAdmin} />
    </div>
  )
}

function WorkspaceSection({
  name,
  isAdmin,
}: {
  name: string
  isAdmin: boolean
}) {
  const router = useRouter()
  const [value, setValue] = useState(name)
  const [pending, setPending] = useState(false)
  const dirty = value.trim() !== name && value.trim().length > 0

  async function save() {
    setPending(true)
    try {
      await saveWorkspace({ data: { name: value.trim() } })
      toast.success('Workspace renamed')
      void router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not rename')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="mt-8">
      <h2 className="text-title font-semibold tracking-tight">Workspace</h2>
      <div className="mt-3 flex max-w-sm items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="ws-name">Name</Label>
          <Input
            id="ws-name"
            value={value}
            disabled={!isAdmin}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Your fund's name"
          />
        </div>
        {isAdmin ? (
          <Button size="sm" disabled={!dirty || pending} onClick={save}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        ) : null}
      </div>
      {!isAdmin ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Only admins can rename the workspace.
        </p>
      ) : null}
    </section>
  )
}

type Member = Awaited<ReturnType<typeof listMembers>>[number]
type Invite = Awaited<ReturnType<typeof listInvites>>[number]

function MembersSection({
  me,
  isAdmin,
  members,
  invites,
}: {
  me: { id: string }
  isAdmin: boolean
  members: Array<Member>
  invites: Array<Invite>
}) {
  const router = useRouter()
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [inviteEmail, setInviteEmail] = useState('')
  const [pending, setPending] = useState(false)

  async function invite() {
    setPending(true)
    try {
      const { url } = await createInvite({
        data: {
          role: inviteRole,
          email: inviteEmail.trim() || undefined,
        },
      })
      setInviteUrl(url)
      setInviteEmail('')
      void router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create invite')
    } finally {
      setPending(false)
    }
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn()
      toast.success(ok)
      void router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That did not work')
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-title font-semibold tracking-tight">Members</h2>

      <ul className="mt-3 divide-y divide-border/60 rounded-lg border border-border">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-micro font-semibold text-background">
              {m.name.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-ui font-medium">
                  {m.name}
                  {m.id === me.id ? (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      you
                    </span>
                  ) : null}
                </span>
                {m.banned ? (
                  <span className="rounded-full bg-destructive/10 px-2 text-xs font-medium text-destructive">
                    suspended
                  </span>
                ) : null}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {m.email}
              </span>
            </span>
            {isAdmin && m.id !== me.id ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="focus-ring rounded-md px-2 py-1 text-xs font-medium text-muted-foreground capitalize hover:bg-accent hover:text-foreground">
                  {m.role}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    onSelect={() =>
                      act(
                        () =>
                          setMemberRole({
                            data: {
                              userId: m.id,
                              role: m.role === 'admin' ? 'member' : 'admin',
                            },
                          }),
                        'Role updated',
                      )
                    }
                  >
                    Make {m.role === 'admin' ? 'member' : 'admin'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant={m.banned ? undefined : 'destructive'}
                    onSelect={() =>
                      act(
                        () =>
                          setMemberBanned({
                            data: { userId: m.id, banned: !m.banned },
                          }),
                        m.banned ? 'Access restored' : 'Access suspended',
                      )
                    }
                  >
                    {m.banned ? 'Restore access' : 'Suspend access'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="px-2 text-xs font-medium text-muted-foreground capitalize">
                {m.role}
              </span>
            )}
          </li>
        ))}
      </ul>

      {isAdmin ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-56 space-y-1.5">
              <Label htmlFor="invite-email">Invite by email (optional)</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="partner@fund.com"
              />
            </div>
            <select
              aria-label="Invite role"
              value={inviteRole}
              onChange={(e) =>
                setInviteRole(e.target.value as 'member' | 'admin')
              }
              className="focus-ring h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button size="sm" disabled={pending} onClick={invite}>
              <Plus className="size-3.5" strokeWidth={2} />
              Create invite
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Single-use link, valid 7 days. Leave email empty for a link anyone
            can use once.
          </p>

          {inviteUrl ? (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-xs">
                {inviteUrl}
              </code>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(inviteUrl).then(
                    () =>
                      toast.success('Link copied — send it however you like'),
                    () => toast.error('Could not copy — select the link above'),
                  )
                }}
              >
                <Copy className="size-3" strokeWidth={2} />
                Copy
              </Button>
            </div>
          ) : null}

          {invites.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {invites.map((inv) => (
                <li
                  key={inv.id}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {inv.email ?? 'Open link'} · {inv.role} · expires{' '}
                    {new Date(inv.expiresAt).toLocaleDateString()}
                  </span>
                  <button
                    className="focus-ring rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                    onClick={() =>
                      act(
                        () => revokeInvite({ data: { id: inv.id } }),
                        'Invite revoked',
                      )
                    }
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

type TemplateRow = Awaited<ReturnType<typeof listTemplates>>[number]

const SUGGEST_KINDS = ['company', 'person', 'deal', 'space'] as const

/**
 * Templates are config, not entities — this is their whole management
 * surface. Creation happens by example ("Save as template" on a note,
 * record, or space), never here.
 */
function TemplatesSection({ templates }: { templates: Array<TemplateRow> }) {
  const router = useRouter()

  async function patch(
    id: string,
    data: { name?: string; archived?: boolean; suggestOn?: Array<string> },
    ok: string,
  ) {
    try {
      await updateTemplate({ data: { id, ...data } })
      toast.success(ok)
      void router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That did not work')
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-title font-semibold tracking-tight">Templates</h2>
      <p className="mt-1 text-ui text-muted-foreground">
        Saved patterns for notes, records, and space breakdowns. Create one from
        any existing note, record, or space — “Save as template”.
      </p>
      {templates.length === 0 ? (
        <p className="mt-3 text-ui text-muted-foreground">
          None yet. Open a note, record, or space you like the shape of and save
          it as the pattern.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border/60 rounded-lg border border-border">
          {templates.map((t) => (
            <li
              key={t.id}
              className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5',
                t.archived && 'opacity-50',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium">
                  {t.name}
                </span>
                <span className="block text-xs text-muted-foreground capitalize">
                  {t.kind === 'record' ? (t.objectKind ?? 'record') : t.kind}
                </span>
              </span>
              <span className="flex items-center gap-1">
                {SUGGEST_KINDS.map((k) => {
                  const on = t.suggestOn.includes(k)
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      title={`Suggest first on ${k} surfaces`}
                      onClick={() =>
                        patch(
                          t.id,
                          {
                            suggestOn: on
                              ? t.suggestOn.filter((x) => x !== k)
                              : [...t.suggestOn, k],
                          },
                          'Suggestion contexts updated',
                        )
                      }
                      className={cn(
                        'focus-ring rounded-full px-2 py-0.5 text-xs capitalize',
                        on
                          ? 'bg-selected font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      {k}
                    </button>
                  )
                })}
              </span>
              <button
                type="button"
                onClick={() =>
                  patch(
                    t.id,
                    { archived: !t.archived },
                    t.archived ? 'Template restored' : 'Template archived',
                  )
                }
                className="focus-ring rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t.archived ? 'Restore' : 'Archive'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * FX rates — the manual rate table behind portfolio currency conversion
 * (CONTEXT.md, 2026-08-06). Sparse on purpose: a rate per (currency, date)
 * when a non-base event needs one; upserting a correction just recomputes.
 */
function FxSection({
  isAdmin,
  baseCurrency,
  rates,
}: {
  isAdmin: boolean
  baseCurrency: string
  rates: Array<{ currency: string; date: string; rateToBase: number }>
}) {
  const router = useRouter()
  const [base, setBase] = useState(baseCurrency)
  const [form, setForm] = useState({ currency: '', date: '', rate: '' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function saveBase() {
    if (base.trim().toUpperCase() === baseCurrency) return
    setPending(true)
    setError(null)
    try {
      await setBaseCurrency({ data: { currency: base.trim().toUpperCase() } })
      toast('Base currency saved')
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  async function addRate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const rate = Number(form.rate)
    if (!form.currency.trim() || !form.date || !(rate > 0)) {
      setError('Currency, date, and a positive rate — all three.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await setFxRate({
        data: {
          currency: form.currency.trim().toUpperCase(),
          date: form.date,
          rateToBase: rate,
        },
      })
      toast('Rate saved')
      setForm({ currency: '', date: '', rate: '' })
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the rate')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-title font-semibold tracking-tight">FX rates</h2>
      <p className="mt-1 text-ui text-muted-foreground">
        Portfolio events keep their own currency; roll-ups convert to the base
        at the latest rate on or before each event's date. A missing rate is
        surfaced, never guessed.
      </p>

      <div className="mt-4 flex items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="fx-base">Base currency</Label>
          <Input
            id="fx-base"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            maxLength={3}
            className="w-24 uppercase"
            disabled={!isAdmin}
          />
        </div>
        {isAdmin && base.trim().toUpperCase() !== baseCurrency ? (
          <Button size="sm" onClick={saveBase} disabled={pending}>
            Save
          </Button>
        ) : null}
      </div>

      <form onSubmit={addRate} className="mt-4 flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="fx-ccy">Currency</Label>
          <Input
            id="fx-ccy"
            value={form.currency}
            onChange={(e) =>
              setForm((s) => ({ ...s, currency: e.target.value }))
            }
            placeholder="USD"
            maxLength={3}
            className="w-24 uppercase"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fx-date">As of</Label>
          <Input
            id="fx-date"
            type="date"
            value={form.date}
            onChange={(e) => setForm((s) => ({ ...s, date: e.target.value }))}
            className="w-40"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fx-rate">1 unit = ? {baseCurrency}</Label>
          <Input
            id="fx-rate"
            type="number"
            step="any"
            min="0"
            value={form.rate}
            onChange={(e) => setForm((s) => ({ ...s, rate: e.target.value }))}
            placeholder="83.20"
            className="w-32"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          Add rate
        </Button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-ui text-destructive">
          {error}
        </p>
      ) : null}

      {rates.length > 0 ? (
        <ol className="mt-4 max-w-md divide-y divide-border rounded-lg border border-border">
          {[...rates]
            .sort(
              (a, b) =>
                a.currency.localeCompare(b.currency) ||
                b.date.localeCompare(a.date),
            )
            .map((r) => (
              <li
                key={`${r.currency}:${r.date}`}
                className="flex items-baseline gap-3 px-4 py-2"
              >
                <span className="w-12 font-medium">{r.currency}</span>
                <span className="tabular text-label text-muted-foreground">
                  {r.date}
                </span>
                <span className="tabular ml-auto">
                  {r.rateToBase} {baseCurrency}
                </span>
              </li>
            ))}
        </ol>
      ) : (
        <p className="mt-4 text-ui text-muted-foreground">
          No rates yet — you'll be prompted the first time a non-
          {baseCurrency} event needs a roll-up.
        </p>
      )}
    </section>
  )
}

/**
 * The object index: one row per object (system rows first), each linking to
 * its attributes page. Custom objects join this list when SPA-13 lands —
 * the page they get is the same one.
 */
function ObjectsSection({
  objects,
  isAdmin,
}: {
  objects: Array<ObjectRow>
  isAdmin: boolean
}) {
  const router = useRouter()
  const live = objects.filter((o) => !o.archived)
  const archived = objects.filter((o) => o.archived)
  return (
    <section className="mt-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-title font-semibold tracking-tight">Objects</h2>
          <p className="mt-1 text-ui text-muted-foreground">
            The records you keep and the attributes on each. Open one to rename,
            reorder, archive, or add attributes — types are fixed.
          </p>
        </div>
        {isAdmin ? (
          <ObjectDialog
            mode="create"
            onSaved={() => router.invalidate()}
            trigger={
              <Button size="xs" variant="outline">
                <Plus className="size-3" strokeWidth={2} />
                New object
              </Button>
            }
          />
        ) : null}
      </div>
      <ul className="mt-4 divide-y divide-border/60 rounded-lg border border-border">
        {live.map((o) => {
          const Icon = objectIcon(o)
          return (
            <li key={o.id}>
              <Link
                to="/settings/objects/$objectSlug"
                params={{ objectSlug: o.slug }}
                className="focus-ring-inset flex items-center gap-3 px-4 py-3 transition-colors duration-150 ease-out-quart hover:bg-accent"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Icon
                    className="size-4 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium">
                    {o.plural}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    <span className="tabular">{o.attributeCount}</span>{' '}
                    attribute{o.attributeCount === 1 ? '' : 's'}
                  </span>
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    o.isSystem
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-selected text-foreground',
                  )}
                >
                  {o.isSystem ? 'System' : 'Custom'}
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground"
                  strokeWidth={1.75}
                />
              </Link>
            </li>
          )
        })}
      </ul>
      {archived.length > 0 ? (
        <ul className="mt-3 divide-y divide-border/60 rounded-lg border border-dashed border-border opacity-70">
          {archived.map((o) => {
            const Icon = objectIcon(o)
            return (
              <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Icon
                    className="size-4 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium">
                    {o.plural}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Archived — records kept, routes and pickers hidden
                  </span>
                </span>
                {isAdmin ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={async () => {
                      await updateObject({
                        data: { id: o.id, archived: false },
                      })
                      toast(`${o.plural} restored`)
                      void router.invalidate()
                    }}
                  >
                    Restore
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
