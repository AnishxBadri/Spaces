import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ChevronRight, Copy, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ObjectDialog } from '#/components/objects/object-dialog'
import { PageHeader } from '#/components/page-header'
import { InitialsMark } from '#/components/record/record-parts'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
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
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Settings"
        description={
          <>
            <span>workspace</span>
            <span>{data.members.length} members</span>
            <span>{data.templates.length} templates</span>
            <span>{data.fx.rates.length} fx rates</span>
            <span>{data.objects.length} objects</span>
            <span>{data.isAdmin ? 'admin' : 'member'}</span>
          </>
        }
      />
      <div className="flex w-full max-w-[56.25rem] flex-col gap-12 px-8 py-8">
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
    </div>
  )
}

/**
 * The settings section pattern: serif title, one sans sentence, a mono
 * crumb on the right, hairline under; then rows on rules with the control
 * on the right.
 */
function SettingsSection({
  title,
  blurb,
  crumb,
  action,
  children,
}: {
  title: string
  blurb: React.ReactNode
  crumb: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col">
      <div className="flex items-end justify-between gap-6 border-b border-hairline pb-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-serif text-lg leading-[1.375rem] font-semibold">
            {title}
          </h2>
          <p className="text-ui text-graphite">{blurb}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {action}
          <span className="label-caps font-normal whitespace-nowrap text-graphite">
            Settings / {crumb}
          </span>
        </div>
      </div>
      {children}
    </section>
  )
}

/** One row: label + hint left, the control right. 48px on a rule. */
function SettingsRow({
  label,
  hint,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 border-b border-rule py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-ui font-medium">{label}</span>
        {hint ? <span className="text-label text-graphite">{hint}</span> : null}
      </div>
      {children ? (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      ) : null}
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
    <SettingsSection
      title="Workspace"
      blurb="The deployment's name. It sits in the chassis next to the mark."
      crumb="Workspace"
    >
      <SettingsRow
        label="Name"
        hint={
          isAdmin
            ? 'Shown to every member.'
            : 'Only admins can rename the workspace.'
        }
      >
        <Input
          id="ws-name"
          aria-label="Workspace name"
          value={value}
          disabled={!isAdmin}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your fund's name"
          className="w-56"
        />
        {isAdmin ? (
          <Button size="sm" disabled={!dirty || pending} onClick={save}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        ) : null}
      </SettingsRow>
    </SettingsSection>
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
    <SettingsSection
      title="Members"
      blurb="Who can open this workspace. Admins change structure; members change records."
      crumb="Members"
    >
      <ul className="flex flex-col">
        {members.map((m) => (
          <li
            key={m.id}
            className="flex h-12 items-center gap-3 border-b border-rule"
          >
            <InitialsMark name={m.name} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-ui font-medium">
                  {m.name}
                  {m.id === me.id ? (
                    <span className="ml-1.5 mono text-micro font-normal text-graphite">
                      you
                    </span>
                  ) : null}
                </span>
                {m.banned ? (
                  <span className="mono text-micro text-destructive">
                    suspended
                  </span>
                ) : null}
              </span>
              <span className="block truncate mono text-micro text-graphite">
                {m.email}
              </span>
            </span>
            {isAdmin && m.id !== me.id ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="focus-ring h-6 border border-rule bg-paper px-2 mono text-micro text-graphite hover:border-hairline hover:text-foreground">
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
              <span className="mono text-micro text-graphite">{m.role}</span>
            )}
          </li>
        ))}
      </ul>

      {isAdmin ? (
        <div className="flex flex-col">
          <SettingsRow
            label="Invite"
            hint="Single-use link, valid 7 days. Leave email empty for a link anyone can use once."
          >
            <Input
              id="invite-email"
              type="email"
              aria-label="Invite by email (optional)"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="partner@fund.com"
              className="w-52"
            />
            <select
              aria-label="Invite role"
              value={inviteRole}
              onChange={(e) =>
                setInviteRole(e.target.value as 'member' | 'admin')
              }
              className="focus-ring h-8 rounded-md border border-rule bg-paper px-2 text-ui"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button size="sm" disabled={pending} onClick={invite}>
              <Plus className="size-3.5" strokeWidth={2} />
              Create invite
            </Button>
          </SettingsRow>

          {inviteUrl ? (
            <div className="mt-3 flex h-9 items-center gap-2 border border-rule bg-bone px-3">
              <code className="min-w-0 flex-1 truncate mono text-micro">
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
            <ul className="flex flex-col">
              {invites.map((inv) => (
                <li
                  key={inv.id}
                  className="flex h-8 items-center gap-2 border-b border-rule mono text-micro text-graphite"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {inv.email ?? 'open link'} · {inv.role} · expires{' '}
                    {new Date(inv.expiresAt).toISOString().slice(0, 10)}
                  </span>
                  <button
                    className="focus-ring hover:text-foreground"
                    onClick={() =>
                      act(
                        () => revokeInvite({ data: { id: inv.id } }),
                        'Invite revoked',
                      )
                    }
                  >
                    revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
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
    <SettingsSection
      title="Templates"
      blurb="Saved patterns for notes, records, and space breakdowns. Create one from any existing note, record, or space — “Save as template”."
      crumb="Templates"
    >
      {templates.length === 0 ? (
        <p className="border-b border-rule py-3 text-label text-graphite">
          None yet. Open a note, record, or space you like the shape of and save
          it as the pattern.
        </p>
      ) : (
        <ul className="flex flex-col">
          {templates.map((t) => (
            <li
              key={t.id}
              className={cn(
                'flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule py-2',
                t.archived && 'text-graphite',
              )}
            >
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-ui font-medium',
                    t.archived && 'line-through',
                  )}
                >
                  {t.name}
                </span>
                <span className="block mono text-micro text-graphite">
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
                        'focus-ring h-6 border px-2 mono text-micro',
                        on
                          ? 'border-hairline bg-paper text-foreground'
                          : 'border-rule text-graphite hover:border-hairline hover:text-foreground',
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
                className="focus-ring mono text-micro text-graphite hover:text-foreground"
              >
                {t.archived ? 'restore' : 'archive'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
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

  const sorted = [...rates].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) || b.date.localeCompare(a.date),
  )
  // Newest per currency is the live rate; older ones are kept for the
  // events dated before it (rates are append-only, a new date supersedes).
  const newest = new Set<string>()
  for (const r of sorted) {
    if (!newest.has(r.currency)) newest.add(`${r.currency}:${r.date}`)
    newest.add(r.currency)
  }
  const isLive = (r: { currency: string; date: string }) =>
    newest.has(`${r.currency}:${r.date}`)
  const currencies = new Set(rates.map((r) => r.currency)).size

  return (
    <SettingsSection
      title="Currency & FX rates"
      blurb="Every holding is priced in the base currency. Rates are entered by hand and dated; a missing rate leaves the holding unpriced, never guessed."
      crumb="Capital"
    >
      <SettingsRow
        label="Base currency"
        hint="Changing it re-prices the portfolio strip; ledgers keep their original currency."
      >
        <Input
          id="fx-base"
          aria-label="Base currency"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          maxLength={3}
          className="w-24 mono uppercase"
          disabled={!isAdmin}
        />
        {isAdmin && base.trim().toUpperCase() !== baseCurrency ? (
          <Button size="sm" onClick={saveBase} disabled={pending}>
            Save
          </Button>
        ) : null}
      </SettingsRow>

      <div className="flex flex-col pt-5">
        <div className="flex items-baseline justify-between pb-2">
          <div className="flex items-baseline gap-3">
            <h3 className="label-caps text-foreground">Rates</h3>
            <span className="mono text-micro text-graphite">
              {rates.length} · sparse, dated, newest wins
            </span>
          </div>
        </div>

        {/* The ledger head. */}
        <div className="flex h-8 items-center border-y border-hairline label-caps text-[0.625rem] font-normal text-graphite">
          <span className="w-35 shrink-0">Pair</span>
          <span className="w-40 shrink-0 pr-4 text-right">Rate</span>
          <span className="w-35 shrink-0">As of</span>
          <span className="min-w-0 flex-1">Used for</span>
        </div>
        {sorted.map((r) => {
          const live = isLive(r)
          return (
            <div
              key={`${r.currency}:${r.date}`}
              className={cn(
                'flex h-9 items-center border-b border-rule',
                live ? 'text-foreground' : 'text-graphite',
              )}
            >
              <span className="w-35 shrink-0 mono text-ui">
                {r.currency} → {baseCurrency}
              </span>
              <span className="w-40 shrink-0 pr-4 numeric text-ui">
                {r.rateToBase}
              </span>
              <span className="w-35 shrink-0 mono text-label">{r.date}</span>
              <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
                {live
                  ? `events on or after ${r.date}`
                  : `superseded · kept for events before the newer rate`}
              </span>
            </div>
          )
        })}

        {/* The composer row: a rate is appended, never edited. */}
        <form
          onSubmit={addRate}
          className="flex min-h-9 flex-wrap items-center gap-2 border-b border-rule py-1"
        >
          <span className="mono text-micro text-primary">+</span>
          <Input
            id="fx-ccy"
            aria-label="Currency"
            value={form.currency}
            onChange={(e) =>
              setForm((s) => ({ ...s, currency: e.target.value }))
            }
            placeholder="EUR"
            maxLength={3}
            className="h-7 w-20 mono uppercase"
          />
          <span className="mono text-micro text-graphite">
            → {baseCurrency}
          </span>
          <Input
            id="fx-rate"
            aria-label={`1 unit in ${baseCurrency}`}
            type="number"
            step="any"
            min="0"
            value={form.rate}
            onChange={(e) => setForm((s) => ({ ...s, rate: e.target.value }))}
            placeholder="1.0900"
            className="h-7 w-28 mono"
          />
          <Input
            id="fx-date"
            aria-label="As of"
            type="date"
            value={form.date}
            onChange={(e) => setForm((s) => ({ ...s, date: e.target.value }))}
            className="h-7 w-40 mono"
          />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Add rate
          </Button>
          {error ? (
            <span role="alert" className="mono text-micro text-destructive">
              {error}
            </span>
          ) : null}
        </form>

        <div className="flex h-8 items-center justify-between">
          <span className="label-caps font-normal text-graphite">
            {rates.length} rate{rates.length === 1 ? '' : 's'} · {currencies}{' '}
            currenc{currencies === 1 ? 'y' : 'ies'}
          </span>
          <span className="mono text-micro text-graphite">
            rates are append-only · a new date supersedes, nothing edits
          </span>
        </div>
      </div>
    </SettingsSection>
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
    <SettingsSection
      title="Objects"
      blurb="The records you keep and the attributes on each. Open one to rename, reorder, archive, or add attributes — types are fixed."
      crumb="Objects"
      action={
        isAdmin ? (
          <ObjectDialog
            mode="create"
            onSaved={() => router.invalidate()}
            trigger={
              <Button size="sm" variant="outline">
                <Plus className="size-3" strokeWidth={2} />
                New object
              </Button>
            }
          />
        ) : null
      }
    >
      <ul className="flex flex-col">
        {live.map((o) => {
          const Icon = objectIcon(o)
          return (
            <li key={o.id}>
              <Link
                to="/settings/objects/$objectSlug"
                params={{ objectSlug: o.slug }}
                className="focus-ring-inset flex h-12 items-center gap-3 border-b border-rule transition-colors duration-150 ease-out-quart hover:bg-bone"
              >
                <span className="flex size-[1.375rem] shrink-0 items-center justify-center border border-hairline bg-paper">
                  <Icon className="size-3 text-foreground" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium">
                    {o.plural}
                  </span>
                  <span className="block mono text-micro text-graphite">
                    {o.attributeCount} attribute
                    {o.attributeCount === 1 ? '' : 's'}
                    {' · '}
                    {o.isSystem ? 'system' : 'custom'}
                  </span>
                </span>
                <ChevronRight
                  className="size-3.5 shrink-0 text-graphite"
                  strokeWidth={1.75}
                />
              </Link>
            </li>
          )
        })}
      </ul>
      {archived.length > 0 ? (
        <ul className="flex flex-col text-graphite">
          {archived.map((o) => {
            const Icon = objectIcon(o)
            return (
              <li
                key={o.id}
                className="flex h-12 items-center gap-3 border-b border-dashed border-rule"
              >
                <span className="flex size-[1.375rem] shrink-0 items-center justify-center border border-rule bg-paper">
                  <Icon className="size-3" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium line-through">
                    {o.plural}
                  </span>
                  <span className="block mono text-micro">
                    archived — records kept, routes and pickers hidden
                  </span>
                </span>
                {isAdmin ? (
                  <button
                    type="button"
                    className="focus-ring mono text-micro hover:text-foreground"
                    onClick={async () => {
                      await updateObject({
                        data: { id: o.id, archived: false },
                      })
                      toast(`${o.plural} restored`)
                      void router.invalidate()
                    }}
                  >
                    restore
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </SettingsSection>
  )
}
