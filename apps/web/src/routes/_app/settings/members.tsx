import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { InitialsMark } from '#/components/record/record-parts'
import { ResetLinkDialog } from '#/components/settings/reset-link-dialog'
import {
  SettingsGroupHead,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
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
import { Select } from '#/components/ui/select'
import type { SelectItem } from '#/components/ui/select'
import {
  createInvite,
  createResetLink,
  revokeInvite,
  setMemberBanned,
  setMemberRole,
} from '#/lib/server-fns'
import type { listInvites, listMembers } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

const shell = getRouteApi('/_app/settings')

/** Who can open this workspace, and the invites outstanding. */
export const Route = createFileRoute('/_app/settings/members')({
  component: MembersRoute,
})

function MembersRoute() {
  const data = shell.useLoaderData()
  return (
    <MembersSection
      me={data.me}
      isAdmin={data.isAdmin}
      members={data.members}
      invites={data.invites}
    />
  )
}

type Member = Awaited<ReturnType<typeof listMembers>>[number]
type Invite = Awaited<ReturnType<typeof listInvites>>[number]

type MemberRole = 'member' | 'admin'

/** The two roles — sentence case, a person reads them. */
const ROLE_ITEMS: Array<SelectItem<MemberRole>> = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
]

const roleOf = (role: string | null): MemberRole =>
  role === 'admin' ? 'admin' : 'member'

const roleLabel = (role: string | null) =>
  roleOf(role) === 'admin' ? 'Admin' : 'Member'

/** "expires in 5 days", from the invite's instant. */
function expiresIn(expiresAt: Date | string): string {
  const days = Math.max(
    0,
    Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000),
  )
  if (days === 0) return 'expires today'
  return `expires in ${String(days)} ${days === 1 ? 'day' : 'days'}`
}

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
  const [inviting, setInviting] = useState(false)
  const [resetLink, setResetLink] = useState<{
    name: string
    url: string
  } | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  /** Suspending signs a member out everywhere, so it asks; restoring does not. */
  async function setBanned(m: Member) {
    if (!m.banned) {
      const ok = await confirm({
        title: `Suspend ${m.name}?`,
        body: 'They cannot sign in until restored, and their API tokens stop working. Their records, notes and tasks stay.',
        action: 'Suspend',
      })
      if (!ok) return
    }
    await act(
      () => setMemberBanned({ data: { userId: m.id, banned: !m.banned } }),
      m.banned ? 'Access restored' : 'Access suspended',
    )
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

  /** Mints the link first; the window opens only to show it. */
  async function sendResetLink(m: Member) {
    try {
      const { url } = await createResetLink({ data: { userId: m.id } })
      setResetLink({ name: m.name, url })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That did not work')
    }
  }

  const setRole = (m: Member, role: MemberRole) =>
    act(() => setMemberRole({ data: { userId: m.id, role } }), 'Role updated')

  return (
    <SettingsSection
      title="Members"
      crumb="Workspace"
      action={
        isAdmin ? (
          <Button size="sm" onClick={() => setInviting(true)}>
            Invite
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col">
        <SettingsGroupHead title="People" count={members.length} />
        <div className="flex h-8 items-center gap-3 border-b border-hairline field-label leading-4 text-graphite">
          <span className="min-w-0 flex-1">Person</span>
          <span className="w-28 shrink-0">Role</span>
          <span className="w-6 shrink-0" />
        </div>
        {members.map((m) => {
          const editable = isAdmin && m.id !== me.id
          return (
            <div
              key={m.id}
              data-member-row
              data-row
              className="flex h-12 items-center gap-3 border-b border-rule"
            >
              <InitialsMark
                name={m.name}
                className={cn(m.banned && 'opacity-40')}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'truncate text-ui font-medium',
                      m.banned && 'text-graphite',
                    )}
                  >
                    {m.name}
                  </span>
                  {m.id === me.id ? (
                    <span className="mono text-micro text-graphite">you</span>
                  ) : null}
                  {m.banned ? (
                    <span className="flex items-center gap-1 mono text-micro text-destructive">
                      <span aria-hidden className="size-1.5 bg-destructive" />
                      suspended
                    </span>
                  ) : null}
                </span>
                <span className="block truncate mono text-micro text-graphite">
                  {m.email}
                </span>
              </span>
              <span className="w-28 shrink-0">
                {editable ? (
                  <Select
                    aria-label={`Role of ${m.name}`}
                    value={roleOf(m.role)}
                    onChange={(role) => void setRole(m, role)}
                    items={ROLE_ITEMS}
                    width="trigger"
                    className="w-28"
                  />
                ) : (
                  <span className="text-ui text-graphite">
                    {roleLabel(m.role)}
                  </span>
                )}
              </span>
              <span className="flex w-6 shrink-0 justify-end">
                {editable ? (
                  <MoreMenu
                    variant="row"
                    label={m.name}
                    items={[
                      {
                        label: `Make ${roleOf(m.role) === 'admin' ? 'member' : 'admin'}`,
                        onSelect: () =>
                          void setRole(
                            m,
                            roleOf(m.role) === 'admin' ? 'member' : 'admin',
                          ),
                      },
                      ...(m.banned
                        ? []
                        : [
                            {
                              label: 'Send a reset link…',
                              opens: true,
                              onSelect: () => void sendResetLink(m),
                            },
                          ]),
                      {
                        label: m.banned ? 'Restore access' : 'Suspend access…',
                        destructive: !m.banned,
                        opens: true,
                        onSelect: () => void setBanned(m),
                      },
                    ]}
                  />
                ) : null}
              </span>
            </div>
          )
        })}
      </div>

      {isAdmin && invites.length > 0 ? (
        <div className="flex flex-col">
          <SettingsGroupHead title="Waiting to join" count={invites.length} />
          {invites.map((inv) => (
            <div
              key={inv.id}
              data-invite-row
              data-row
              className="flex h-12 items-center gap-3 border-b border-rule"
            >
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-ui',
                    inv.email === null && 'text-graphite',
                  )}
                >
                  {inv.email ?? 'Anyone with the link'}
                </span>
                <span className="block truncate mono text-micro text-graphite">
                  {roleLabel(inv.role)}
                  {inv.email === null ? ' · one use' : ''} ·{' '}
                  {expiresIn(inv.expiresAt)}
                </span>
              </span>
              <span className="flex shrink-0 justify-end">
                <MoreMenu
                  variant="row"
                  label={inv.email ?? 'the open link'}
                  items={[
                    {
                      label: 'Revoke invite',
                      destructive: true,
                      onSelect: () =>
                        void act(
                          () => revokeInvite({ data: { id: inv.id } }),
                          'Invite revoked',
                        ),
                    },
                  ]}
                />
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {isAdmin ? (
        <InviteDialog
          open={inviting}
          onOpenChange={setInviting}
          onCreated={() => void router.invalidate()}
        />
      ) : null}
      <ResetLinkDialog link={resetLink} onClose={() => setResetLink(null)} />
      {confirmDialog}
    </SettingsSection>
  )
}

/**
 * The Invite window: email (optional) and role, then the link, shown once —
 * only its hash is stored. Cancel in the foot is its one close.
 */
function InviteDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberRole>('member')
  const [url, setUrl] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function change(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setEmail('')
      setRole('member')
      setUrl(null)
      setError(null)
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const created = await createInvite({
        data: { role, ...(email.trim() ? { email: email.trim() } : {}) },
      })
      setUrl(created.url)
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create invite')
    } finally {
      setPending(false)
    }
  }

  function copy(link: string) {
    navigator.clipboard.writeText(link).then(
      () => toast.success('Link copied'),
      () => toast.error('Could not copy — select the link'),
    )
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Invite</DialogTitle>
        </DialogHeader>
        {url === null ? (
          <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="partner@fund.example"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                id="invite-role"
                aria-label="Invite role"
                value={role}
                onChange={setRole}
                items={ROLE_ITEMS}
                width="trigger"
              />
            </div>
            {error ? (
              <p role="alert" className="text-ui text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter
              note={
                email.trim() === ''
                  ? 'anyone with the link · one use · 7 days'
                  : null
              }
            >
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending ? 'Creating…' : 'Create invite'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col">
            <div className="flex h-9 items-center gap-2 border border-rule bg-bone px-3">
              <code className="min-w-0 flex-1 truncate mono text-micro select-all">
                {url}
              </code>
              <Button size="xs" variant="outline" onClick={() => copy(url)}>
                <Copy className="size-3" strokeWidth={2} />
                Copy link
              </Button>
            </div>
            <DialogFooter note="shown once">
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
