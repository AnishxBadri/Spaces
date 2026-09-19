import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthShell, FormError } from '#/components/auth-shell'
import { KeyHint } from '#/components/page-header'
import { PasswordInput } from '#/components/password-input'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { authClient } from '#/lib/auth-client'
import { getSession, getSetupState } from '#/lib/server-fns'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const { needsSetup } = await getSetupState()
    if (needsSetup) throw redirect({ to: '/setup' })
    const session = await getSession()
    if (session) throw redirect({ to: '/today' })
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
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
      foot="No account? Ask your admin for an invitation."
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
          <KeyHint>↵</KeyHint>
        </Button>
      </form>
    </AuthShell>
  )
}
