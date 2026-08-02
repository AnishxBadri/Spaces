import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Wordmark } from '#/components/wordmark'
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
    if (session) throw redirect({ to: '/spaces' })
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
    navigate({ to: '/spaces' })
  }

  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-6">
      <div className="w-full max-w-[360px] pt-[22vh]">
        <Wordmark />
        <h1 className="mt-8 text-page font-semibold tracking-tight">Sign in</h1>

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div className="space-y-1.5">
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
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </div>

          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-6 text-ui text-muted-foreground">
          No account? Ask your admin for an invitation.
        </p>
      </div>
    </main>
  )
}
