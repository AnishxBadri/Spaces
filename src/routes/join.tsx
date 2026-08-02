import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { Wordmark } from '#/components/wordmark'
import { PasswordInput } from '#/components/password-input'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { authClient } from '#/lib/auth-client'
import { getInvitePreview, getSession } from '#/lib/server-fns'

/**
 * Invite acceptance. The link carries the raw token; only its hash exists
 * in the database, and the Better Auth database hook — not this route — is
 * what validates it, so hitting the signup endpoint directly buys nothing.
 */
export const Route = createFileRoute('/join')({
  validateSearch: z.object({ token: z.string().catch('') }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => {
    const session = await getSession()
    if (session) throw redirect({ to: '/spaces' })
    if (!deps.token) return { preview: { valid: false as const } }
    const preview = await getInvitePreview({ data: { token: deps.token } })
    return { preview }
  },
  component: JoinPage,
})

function JoinPage() {
  const { preview } = Route.useLoaderData()
  const { token } = Route.useSearch()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  if (!preview.valid) {
    return (
      <Shell>
        <h1 className="mt-6 text-page font-semibold tracking-tight">
          This invitation isn’t valid
        </h1>
        <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
          The link may have expired, been revoked, or already been used —
          invitations work exactly once. Ask the person who invited you for a
          fresh one.
        </p>
      </Shell>
    )
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)
    const password = String(form.get('password'))
    if (password.length < 12) {
      setError('Password needs at least 12 characters.')
      return
    }
    setPending(true)
    const { error: err } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: preview.email ?? String(form.get('email')),
      password,
      fetchOptions: { headers: { 'x-invite-token': token } },
    })
    setPending(false)
    if (err) {
      setError(err.message ?? 'Could not create the account.')
      return
    }
    navigate({ to: '/spaces' })
  }

  return (
    <Shell>
      <h1 className="mt-6 text-page font-semibold tracking-tight">
        {preview.workspaceName
          ? `Join ${preview.workspaceName}`
          : 'Join this workspace'}
      </h1>
      <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
        You’ve been invited{preview.role === 'admin' ? ' as an admin' : ''}.
        Create your account to get in.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" name="name" autoComplete="name" required autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          {preview.email ? (
            <>
              <Input id="email" value={preview.email} disabled />
              <p className="text-xs text-muted-foreground">
                This invitation is locked to this address.
              </p>
            </>
          ) : (
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@fund.com"
            />
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={12}
          />
        </div>

        {error ? (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Joining…' : 'Join workspace'}
        </Button>
      </form>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-6">
      <div className="w-full max-w-[400px] pt-[18vh] pb-16">
        <Wordmark />
        {children}
      </div>
    </main>
  )
}
