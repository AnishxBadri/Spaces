import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { AuthShell, FieldHint, FormError } from '#/components/auth-shell'
import { PasswordInput } from '#/components/password-input'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { authClient } from '#/lib/auth-client'
import { getResetPreview, getSession } from '#/lib/server-fns'

/**
 * An admin-issued password reset link. The link carries the raw token; Better
 * Auth's `/reset-password` is what spends it, once, and signs the member out
 * everywhere — this page only asks whether it still works before drawing the
 * form.
 */
export const Route = createFileRoute('/reset')({
  validateSearch: z.object({ token: z.string().catch('') }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => {
    const session = await getSession()
    if (session) throw redirect({ to: '/today' })
    if (!deps.token) return { valid: false }
    return getResetPreview({ data: { token: deps.token } })
  },
  component: ResetPage,
})

function ResetPage() {
  const preview = Route.useLoaderData()
  const { token } = Route.useSearch()
  const navigate = useNavigate()
  const [spent, setSpent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  if (!preview.valid || spent) {
    return (
      <AuthShell
        eyebrow="Password reset"
        title="This link isn’t valid"
        blurb="Each link works once. Ask an admin for a new one."
      >
        {null}
      </AuthShell>
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
    if (password !== String(form.get('again'))) {
      setError('The two passwords differ.')
      return
    }
    setPending(true)
    const { error: err } = await authClient.resetPassword({
      newPassword: password,
      token,
    })
    setPending(false)
    if (err) {
      if (err.code === 'INVALID_TOKEN') setSpent(true)
      else setError(err.message ?? 'Could not set the password.')
      return
    }
    void navigate({ to: '/login', search: { reset: 'done' } })
  }

  return (
    <AuthShell
      eyebrow="Password reset"
      title="Set a new password"
      foot="This link works once."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">New password</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            required
            autoFocus
            minLength={12}
            aria-describedby="password-hint"
          />
          <FieldHint id="password-hint">At least 12 characters</FieldHint>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="again">Again</Label>
          <PasswordInput
            id="again"
            name="again"
            autoComplete="new-password"
            required
            minLength={12}
          />
        </div>

        {error ? <FormError>{error}</FormError> : null}

        <Button type="submit" className="w-full" pending={pending}>
          {pending ? 'Setting…' : 'Set password'}
        </Button>
      </form>
    </AuthShell>
  )
}
