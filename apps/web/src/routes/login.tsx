import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { AuthShell, FormError } from '#/components/auth-shell'
import { PasswordInput } from '#/components/password-input'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { authClient } from '#/lib/auth-client'
import { getSession, getSetupState } from '#/lib/server-fns'

export const Route = createFileRoute('/login')({
  // `reset=done` is where a reset link lands once the password is set;
  // `from=setup` is where a closed /setup sends whoever opened it.
  validateSearch: z.object({
    reset: z.string().optional(),
    from: z.string().optional(),
  }),
  beforeLoad: async () => {
    const { needsSetup, workspaceName } = await getSetupState()
    if (needsSetup) throw redirect({ to: '/setup' })
    const session = await getSession()
    if (session) throw redirect({ to: '/today' })
    return { workspaceName }
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const { reset, from } = Route.useSearch()
  const { workspaceName } = Route.useRouteContext()
  const [error, setError] = useState<string | null>(null)
  const [forgot, setForgot] = useState(false)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setPending(true)
    const form = new FormData(e.currentTarget)
    const { error: err } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    setPending(false)
    if (err) {
      setForgot(err.status !== 429)
      setError(
        err.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : 'Wrong email or password.',
      )
      return
    }
    void navigate({ to: '/today' })
  }

  return (
    <AuthShell
      eyebrow="Sign in"
      title="Welcome back"
      blurb={
        reset === 'done'
          ? 'Password set. Sign in with it.'
          : from === 'setup'
            ? `${workspaceName ?? 'This workspace'} is set up. Everyone else joins by invitation.`
            : null
      }
      foot={
        forgot
          ? 'Forgot it? An admin can send you a reset link.'
          : 'No account? Ask your admin for an invitation.'
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="you@fund.com"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </div>

        {error ? <FormError>{error}</FormError> : null}

        <Button type="submit" className="w-full" pending={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  )
}
