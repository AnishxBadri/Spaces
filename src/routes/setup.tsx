import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Wordmark } from '#/components/wordmark'
import { PasswordInput } from '#/components/password-input'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { authClient } from '#/lib/auth-client'
import {
  getSession,
  getSetupState,
  saveWorkspace,
  seedDemo,
} from '#/lib/server-fns'

/**
 * First-run wizard — deliberately minimal (CONTEXT.md, 2026-08): setup
 * token → admin + workspace name → optional demo data. Under a minute.
 * AI-key and Gmail steps join only when their features ship; the mandate is
 * written from its own page, not here.
 *
 * The token is enforced in the Better Auth database hook, not this route —
 * the public signup endpoint would bypass anything checked here. This form
 * merely carries it along as a header.
 */
export const Route = createFileRoute('/setup')({
  beforeLoad: async () => {
    const { needsSetup } = await getSetupState()
    if (!needsSetup) {
      // Admin exists. Only a signed-in user (mid-wizard step 2) may stay.
      const session = await getSession()
      if (!session) throw redirect({ to: '/login' })
    }
  },
  component: SetupWizard,
})

function SetupWizard() {
  const [step, setStep] = useState<1 | 2>(1)

  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-6">
      <div className="w-full max-w-[400px] pt-[18vh] pb-16">
        <Wordmark />
        <p className="mt-3 text-xs font-medium text-muted-foreground tabular">
          Step {step} of 2
        </p>
        {step === 1 ? <AdminStep onDone={() => setStep(2)} /> : <DemoStep />}
      </div>
    </main>
  )
}

function AdminStep({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)
    const password = String(form.get('password'))
    if (password.length < 12) {
      setError('Password needs at least 12 characters.')
      return
    }
    const workspaceName = String(form.get('workspace')).trim()
    if (!workspaceName) {
      setError('Give the workspace a name — usually the fund’s.')
      return
    }
    setPending(true)
    const { error: err } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password,
      fetchOptions: {
        headers: { 'x-setup-token': String(form.get('token')).trim() },
      },
    })
    if (err) {
      setPending(false)
      setError(err.message ?? 'Could not create the account.')
      return
    }
    try {
      await saveWorkspace({ data: { name: workspaceName } })
    } catch {
      // Account exists and session is live — the name can be set again in
      // settings. Do not strand the operator on a half-failed step.
    }
    setPending(false)
    onDone()
  }

  return (
    <>
      <h1 className="mt-6 text-[22px] font-semibold tracking-tight">
        Create the admin account
      </h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        This deployment is yours. Signup closes permanently after this account
        exists — everyone else joins by invitation.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="token">Setup token</Label>
          <Input
            id="token"
            name="token"
            autoComplete="off"
            required
            autoFocus
            placeholder="Printed in the server logs"
            aria-describedby="token-hint"
          />
          <p id="token-hint" className="text-xs text-muted-foreground">
            One-time code from the terminal or container logs — proof you run
            this server.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="workspace">Workspace name</Label>
          <Input
            id="workspace"
            name="workspace"
            required
            placeholder="Meridian Ventures"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" name="name" autoComplete="name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@fund.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={12}
            aria-describedby="password-hint"
          />
          <p id="password-hint" className="text-xs text-muted-foreground">
            At least 12 characters. This protects deal terms and cap tables.
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Creating…' : 'Create account'}
        </Button>
      </form>
    </>
  )
}

/**
 * Demo data, offered rather than assumed. The starter taxonomy is
 * deliberately tiny (CONTEXT.md), so this is what keeps a fresh install from
 * being an empty page — but shipping it silently would put fictional
 * companies in someone's CRM, so it is a choice with a visible cost.
 */
function DemoStep() {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function withDemo() {
    setPending(true)
    setError(null)
    try {
      await seedDemo()
      navigate({ to: '/spaces' })
    } catch {
      setError('Could not load the demo data. You can start empty instead.')
      setPending(false)
    }
  }

  return (
    <>
      <h1 className="mt-6 text-[22px] font-semibold tracking-tight">
        Start with demo data?
      </h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        A worked example in data-center cooling — a small space tree, three
        companies, a memo, and a glossary. Obviously fictional, and safe to
        delete once you have seen how the pieces connect.
      </p>

      {error ? (
        <p role="alert" className="mt-4 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex gap-2">
        <Button className="flex-1" disabled={pending} onClick={withDemo}>
          {pending ? 'Loading…' : 'Load demo data'}
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => navigate({ to: '/spaces' })}
        >
          Start empty
        </Button>
      </div>
    </>
  )
}
