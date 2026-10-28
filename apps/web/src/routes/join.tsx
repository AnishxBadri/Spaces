import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { AuthShell, FieldHint, FormError } from '#/components/auth-shell'
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
      <AuthShell
        eyebrow="Invitation"
        title="This invitation isn’t valid"
        blurb="Each link works once. Ask whoever invited you for a new one."
      />
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
    void navigate({ to: '/spaces' })
  }

  return (
    <AuthShell
      eyebrow={`Invitation${preview.role === 'admin' ? ' · admin' : ''}`}
      title={
        preview.workspaceName
          ? `Join ${preview.workspaceName}`
          : 'Join this workspace'
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" name="name" autoComplete="name" required autoFocus />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          {preview.email ? (
            // Locked to the invited address: read-only on bone, not disabled,
            // so it still reads at full contrast.
            <Input
              id="email"
              value={preview.email}
              readOnly
              className="bg-bone mono"
            />
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={12}
            aria-describedby="password-hint"
          />
          <FieldHint id="password-hint">At least 12 characters</FieldHint>
        </div>

        {error ? <FormError>{error}</FormError> : null}

        <Button type="submit" className="w-full" pending={pending}>
          {pending ? 'Joining…' : 'Join workspace'}
        </Button>
      </form>
    </AuthShell>
  )
}
