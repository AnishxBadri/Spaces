import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { Copy, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { InitialsMark } from '#/components/record/record-parts'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
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
  revokeInvite,
  setMemberBanned,
  setMemberRole,
} from '#/lib/server-fns'
import type { listInvites, listMembers } from '#/lib/server-fns'

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
          ...(inviteEmail.trim() ? { email: inviteEmail.trim() } : {}),
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
      crumb="Workspace"
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
                    {...(m.banned ? {} : { variant: 'destructive' as const })}
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
                setInviteRole(e.target.value === 'admin' ? 'admin' : 'member')
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
