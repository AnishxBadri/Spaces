import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthShell, FieldHint, FormError } from '#/components/auth-shell'
import { KeyHint } from '#/components/page-header'
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
      // Admin exists. Only a signed-in user (mid-wizard step 2) may stay —
      // and a refresh must land them on step 2, not the dead admin form
      // (the setup token is gone; resubmitting can only fail).
      const session = await getSession()
      if (!session) throw redirect({ to: '/login' })
      return { initialStep: 2 as const }
    }
    return { initialStep: 1 as const }
  },
  component: SetupWizard,
})

function SetupWizard() {
  const { initialStep } = Route.useRouteContext()
  const [step, setStep] = useState<1 | 2>(initialStep)
  return step === 1 ? <AdminStep onDone={() => setStep(2)} /> : <DemoStep />
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
      setError('Give the workspace a name — yours or the fund’s.')
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
    <AuthShell
      eyebrow="Setup · step 1 of 2"
      title="Create the admin account"
      blurb="This deployment is yours. Signup closes permanently after this account exists — everyone else joins by invitation."
      foot="self-hosted · nothing here leaves this server"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="token">Setup token</Label>
          <Input
            id="token"
            name="token"
            autoComplete="off"
            required
            autoFocus
            placeholder="Printed in the server logs"
            aria-describedby="token-hint"
            className="mono"
          />
          <FieldHint id="token-hint">
            One-time code from the terminal or container logs — proof you run
            this server.
          </FieldHint>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="workspace">Workspace name</Label>
          <Input
            id="workspace"
            name="workspace"
            required
            placeholder="Priya Mehta, or Meridian Ventures"
            aria-describedby="workspace-hint"
          />
          <FieldHint id="workspace-hint">
            Your name if you invest solo, your fund’s if you don’t.
          </FieldHint>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" name="name" autoComplete="name" required />
        </div>
        <div className="flex flex-col gap-1.5">
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
          <FieldHint id="password-hint">
            At least 12 characters. This protects deal terms and cap tables.
          </FieldHint>
        </div>

        {error ? <FormError>{error}</FormError> : null}

        <Button type="submit" className="w-full" pending={pending}>
          {pending ? 'Creating…' : 'Create account'}
          <KeyHint>↵</KeyHint>
        </Button>
      </form>
    </AuthShell>
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
      void navigate({ to: '/spaces' })
    } catch {
      setError('Could not load the demo data. You can start empty instead.')
      setPending(false)
    }
  }

  return (
    <AuthShell
      eyebrow="Setup · step 2 of 2"
      title="Start with demo data?"
      blurb="A worked example in data-center cooling — a small space tree, three companies, a memo, and a glossary. Obviously fictional, and safe to delete once you have seen how the pieces connect."
      foot="3 companies · 1 memo · 1 space tree · deletable"
    >
      <div className="flex flex-col gap-4">
        {error ? <FormError>{error}</FormError> : null}
        <div className="flex gap-2">
          <Button className="flex-1" disabled={pending} onClick={withDemo}>
            {pending ? 'Loading…' : 'Load demo data'}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => navigate({ to: '/spaces' })}
          >
            Start empty
          </Button>
        </div>
      </div>
    </AuthShell>
  )
}
