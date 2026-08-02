import { createFileRoute, useRouter } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Building2,
  Check,
  Copy,
  Kanban,
  Pencil,
  Plus,
  Users,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  BADGE_COLORS,
  badgeStyle,
  nextBadgeColor,
  optionColor,
} from '#/lib/attributes/colors'
import type { BadgeColor } from '#/lib/attributes/colors'
import {
  createInvite,
  getSession,
  getWorkspace,
  listInvites,
  listMembers,
  listRegistry,
  listTemplates,
  revokeInvite,
  saveWorkspace,
  setMemberBanned,
  setMemberRole,
  updateAttribute,
  updateTemplate,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * Settings: the workspace singleton, members + invites, and the attribute
 * registries behind Companies, People, Deals. Structure fixed, content
 * free; admin owns the destructive edges.
 */
export const Route = createFileRoute('/_app/settings')({
  loader: async () => {
    const [session, workspace, members, templates, company, person, deal] =
      await Promise.all([
        getSession(),
        getWorkspace(),
        listMembers(),
        listTemplates({ data: { includeArchived: true } }),
        listRegistry({ data: { kind: 'company', includeArchived: true } }),
        listRegistry({ data: { kind: 'person', includeArchived: true } }),
        listRegistry({ data: { kind: 'deal', includeArchived: true } }),
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
      company,
      person,
      deal,
    }
  },
  component: SettingsPage,
})

type Registry = Awaited<ReturnType<typeof listRegistry>>
type Attr = Registry[number]
type Kind = 'company' | 'person' | 'deal'

const OBJECTS: Array<{ kind: Kind; label: string; icon: typeof Building2 }> = [
  { kind: 'company', label: 'Companies', icon: Building2 },
  { kind: 'person', label: 'People', icon: Users },
  { kind: 'deal', label: 'Deals', icon: Kanban },
]

const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  currency: 'Currency',
  date: 'Date',
  checkbox: 'Checkbox',
  select: 'Select',
  multi_select: 'Multi-select',
  status: 'Status',
  domain: 'Domain',
  email: 'Email',
  url: 'URL',
  phone: 'Phone',
  rating: 'Rating',
  record_reference: 'Relationship',
  actor_reference: 'User',
}

function SettingsPage() {
  const data = Route.useLoaderData()
  const registries = {
    company: data.company,
    person: data.person,
    deal: data.deal,
  }
  const router = useRouter()
  const [kind, setKind] = useState<Kind>('company')
  const registry = registries[kind]

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 md:px-10">
      <header>
        <h1 className="text-page font-semibold tracking-tight">Settings</h1>
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

      <h2 className="mt-10 text-title font-semibold tracking-tight">Objects</h2>
      <p className="mt-1 text-ui text-muted-foreground">
        Attributes behind Companies, People, Deals. Rename anything, edit
        options, archive what you don't use — types are fixed.
      </p>

      <div className="mt-4 flex items-center justify-between border-b border-border">
        <div role="tablist" className="flex gap-1">
          {OBJECTS.map((o) => (
            <button
              key={o.kind}
              role="tab"
              aria-selected={kind === o.kind}
              onClick={() => setKind(o.kind)}
              className={cn(
                'relative flex items-center gap-1.5 px-3 pb-2.5 text-ui font-medium text-muted-foreground transition-colors hover:text-foreground focus-ring rounded-t-md',
                kind === o.kind &&
                  'text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary',
              )}
            >
              <o.icon className="size-3.5" strokeWidth={1.75} />
              {o.label}
              <span className="tabular text-xs text-muted-foreground">
                {registries[o.kind].filter((a) => !a.archived).length}
              </span>
            </button>
          ))}
        </div>
        <AttributeCreateDialog
          objectKind={kind}
          onCreated={() => router.invalidate()}
          trigger={
            <Button size="xs" variant="outline">
              <Plus className="size-3" strokeWidth={2} />
              New attribute
            </Button>
          }
        />
      </div>

      <ul className="mt-4 divide-y divide-border/60 rounded-lg border border-border">
        {registry.map((attr, idx) => (
          <AttributeRow
            key={attr.id}
            attr={attr}
            isFirst={idx === 0}
            isLast={idx === registry.length - 1}
          />
        ))}
      </ul>
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
      router.invalidate()
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
      router.invalidate()
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
      router.invalidate()
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
                <DropdownMenuTrigger className="rounded-md px-2 py-1 text-xs font-medium capitalize text-muted-foreground hover:bg-accent hover:text-foreground focus-ring">
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
              <span className="px-2 text-xs font-medium capitalize text-muted-foreground">
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
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-ring"
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
                  navigator.clipboard.writeText(inviteUrl)
                  toast.success('Link copied — send it however you like')
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
                    className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-ring"
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
      router.invalidate()
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
                <span className="block text-xs capitalize text-muted-foreground">
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

function AttributeRow({
  attr,
  isFirst,
  isLast,
}: {
  attr: Attr
  isFirst: boolean
  isLast: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)

  async function act(
    patch: Parameters<typeof updateAttribute>[0]['data'] extends infer D
      ? Omit<D, 'id'>
      : never,
    message?: string,
  ) {
    try {
      await updateAttribute({ data: { id: attr.id, ...patch } })
      if (message) toast(message)
      router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update')
    }
  }

  const options =
    ((attr.options as Record<string, unknown> | null)?.options as Array<{
      id: string
      label: string
      group?: string
      color?: string
    }>) ?? []
  const hasOptions = ['select', 'multi_select', 'status'].includes(attr.type)

  return (
    <li
      className={cn(
        'flex flex-col gap-2 px-4 py-3',
        attr.archived && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <InlineName name={attr.name} onSave={(name) => act({ name })} />
          <span className="text-xs text-muted-foreground">
            {TYPE_LABELS[attr.type] ?? attr.type}
            {attr.type === 'record_reference'
              ? ` → ${(attr.options as Record<string, unknown> | null)?.targetKind ?? ''}`
              : ''}
          </span>
        </div>

        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            attr.isSystem
              ? 'bg-muted text-muted-foreground'
              : 'bg-selected text-foreground',
          )}
        >
          {attr.isSystem ? 'System' : 'Custom'}
        </span>

        <div className="flex items-center gap-0.5">
          <IconBtn
            label="Move up"
            disabled={isFirst}
            onClick={() => act({ move: 'up' })}
          >
            <ArrowUp className="size-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn
            label="Move down"
            disabled={isLast}
            onClick={() => act({ move: 'down' })}
          >
            <ArrowDown className="size-3.5" strokeWidth={1.75} />
          </IconBtn>
          {hasOptions ? (
            <IconBtn
              label={editing ? 'Close options' : 'Edit options'}
              onClick={() => setEditing((v) => !v)}
            >
              <Pencil className="size-3.5" strokeWidth={1.75} />
            </IconBtn>
          ) : null}
          <IconBtn
            label={attr.archived ? 'Restore' : 'Archive'}
            onClick={() =>
              act(
                { archived: !attr.archived },
                attr.archived
                  ? `${attr.name} restored`
                  : `${attr.name} archived`,
              )
            }
          >
            {attr.archived ? (
              <ArchiveRestore className="size-3.5" strokeWidth={1.75} />
            ) : (
              <Archive className="size-3.5" strokeWidth={1.75} />
            )}
          </IconBtn>
        </div>
      </div>

      {hasOptions && !editing && options.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {options.map((o, i) => (
            <span
              key={o.id}
              style={badgeStyle(optionColor(o, i))}
              className="rounded-full px-2 py-0.5 text-label font-medium"
            >
              {o.label}
            </span>
          ))}
        </div>
      ) : null}

      {hasOptions && editing ? (
        <OptionsEditor
          attr={attr}
          options={options}
          onDone={(next) => {
            setEditing(false)
            if (next) act({ options: next }, 'Options saved')
          }}
        />
      ) : null}
    </li>
  )
}

function InlineName({
  name,
  onSave,
}: {
  name: string
  onSave: (name: string) => void
}) {
  const [draft, setDraft] = useState(name)
  return (
    <input
      value={draft}
      aria-label="Attribute name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() && draft !== name && onSave(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(name)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className="focus-ring block w-full truncate rounded bg-transparent text-ui font-medium"
    />
  )
}

function OptionsEditor({
  attr,
  options,
  onDone,
}: {
  attr: Attr
  options: Array<{
    id: string
    label: string
    group?: string
    color?: string
  }>
  onDone: (
    next: Array<{
      id?: string
      label: string
      group?: 'active' | 'parked' | 'closed'
      color?: BadgeColor
    }> | null,
  ) => void
}) {
  const [drafts, setDrafts] = useState(
    options.map((o, i) => ({
      ...o,
      color: optionColor(o, i),
    })) as Array<{
      id?: string
      label: string
      group?: 'active' | 'parked' | 'closed'
      color: BadgeColor
    }>,
  )
  const isStatus = attr.type === 'status'

  return (
    <div className="rounded-md border border-border p-3">
      <div className="space-y-1.5">
        {drafts.map((o, i) => (
          <div key={o.id ?? `new-${i}`} className="flex items-center gap-2">
            <Input
              value={o.label}
              aria-label={`Option ${i + 1}`}
              onChange={(e) =>
                setDrafts((ds) =>
                  ds.map((d, j) =>
                    j === i ? { ...d, label: e.target.value } : d,
                  ),
                )
              }
              className="h-7 max-w-56 text-xs"
            />
            {isStatus ? (
              <select
                value={o.group ?? 'active'}
                aria-label="Group"
                onChange={(e) =>
                  setDrafts((ds) =>
                    ds.map((d, j) =>
                      j === i ? { ...d, group: e.target.value as 'active' } : d,
                    ),
                  )
                }
                className="border-input h-7 rounded-md border bg-transparent px-2 text-xs outline-none"
              >
                <option value="active">Active</option>
                <option value="parked">Parked</option>
                <option value="closed">Closed</option>
              </select>
            ) : null}
            <ColorPicker
              value={o.color}
              label={o.label || `Option ${i + 1}`}
              onPick={(color) =>
                setDrafts((ds) =>
                  ds.map((d, j) => (j === i ? { ...d, color } : d)),
                )
              }
            />
            {!o.id ? (
              <IconBtn
                label="Remove new option"
                onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}
              >
                <X className="size-3" strokeWidth={2} />
              </IconBtn>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            setDrafts((ds) => [
              ...ds,
              {
                label: '',
                color: nextBadgeColor(
                  ds.length,
                  isStatus ? 'active' : undefined,
                ),
                ...(isStatus ? { group: 'active' as const } : {}),
              },
            ])
          }
        >
          <Plus className="size-3" strokeWidth={2} />
          Add option
        </Button>
        <span className="text-xs text-muted-foreground">
          Existing options can be renamed, not removed.
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button
            size="xs"
            onClick={() => onDone(drafts.filter((d) => d.label.trim()))}
          >
            <Check className="size-3" strokeWidth={2} />
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6.5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-ring"
    >
      {children}
    </button>
  )
}

/**
 * Swatch picker for one option's badge colour. A fixed grid of the shipped
 * palette rather than a colour input: every swatch is already known to clear
 * AA against its own ink, which an arbitrary hex cannot promise.
 */
function ColorPicker({
  value,
  label,
  onPick,
}: {
  value: BadgeColor
  label: string
  onPick: (color: BadgeColor) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Colour for ${label}`}
        title={`Colour: ${value}`}
        className="focus-ring size-6 shrink-0 rounded-full border border-border transition-colors duration-150 ease-out-quart hover:border-input"
        style={{ backgroundColor: `var(--badge-${value})` }}
      >
        <span
          className="mx-auto block size-2.5 rounded-full"
          style={{ backgroundColor: `var(--badge-${value}-ink)` }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto p-2">
        {/* Menu items rather than plain buttons: a raw <button> inside Radix
            content leaves the popover open after a pick, so choosing a colour
            silently traps the next click. Items also get roving arrow-key
            focus, which a grid of buttons would not. */}
        <div className="grid grid-cols-6 gap-1.5">
          {BADGE_COLORS.map((c) => (
            <DropdownMenuItem
              key={c}
              aria-label={c}
              title={c}
              onSelect={() => onPick(c)}
              style={badgeStyle(c)}
              className={cn(
                'focus-ring flex size-7 items-center justify-center rounded-full border p-0 transition-colors duration-150 ease-out-quart',
                c === value ? 'border-foreground' : 'border-transparent',
              )}
            >
              {c === value ? (
                <Check className="size-3" strokeWidth={3} />
              ) : null}
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
