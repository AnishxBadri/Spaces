import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Wordmark } from '#/components/wordmark'
import { PasswordInput } from '#/components/password-input'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { authClient } from '#/lib/auth-client'
import { getSession, getSetupState, saveAiKey, seedDemo } from '#/lib/server-fns'

/**
 * First-run wizard. Two steps, both real:
 *  1. Create the admin account (signup closes permanently after).
 *  2. Optional BYOK AI key into the vault. Skippable — no key means AI
 *     features stay hidden, everything else works.
 *
 * TODO(setup-token): CONTEXT.md trap #2 — one-time token printed to
 * container logs, required here. Env-gated, lands before first release.
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

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { id: 'google', label: 'Google', placeholder: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…' },
  { id: 'ollama', label: 'Ollama', placeholder: 'unused — local' },
] as const

type ProviderId = (typeof PROVIDERS)[number]['id']

function SetupWizard() {
  const [step, setStep] = useState<1 | 2 | 3>(1)

  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-6">
      <div className="w-full max-w-[400px] pt-[18vh] pb-16">
        <Wordmark />
        <p className="mt-3 text-xs font-medium text-muted-foreground tabular">
          Step {step} of 3
        </p>
        {step === 1 ? (
          <AdminStep onDone={() => setStep(2)} />
        ) : step === 2 ? (
          <AiKeyStep onDone={() => setStep(3)} />
        ) : (
          <DemoStep />
        )}
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
    setPending(true)
    const { error: err } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password,
    })
    setPending(false)
    if (err) {
      setError(err.message ?? 'Could not create the account.')
      return
    }
    onDone()
  }

  return (
    <>
      <h1 className="mt-6 text-[22px] font-semibold tracking-tight">
        Create the admin account
      </h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        This deployment is yours. Signup closes permanently after this
        account exists — everyone else joins by invitation.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" autoComplete="name" required autoFocus />
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

function AiKeyStep({ onDone }: { onDone: () => void }) {
  const [provider, setProvider] = useState<ProviderId>('anthropic')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  const selected = PROVIDERS.find((p) => p.id === provider)!

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)
    const key = String(form.get('key')).trim()
    if (!key) {
      setError('Paste a key, or skip this step.')
      return
    }
    setPending(true)
    try {
      const { display } = await saveAiKey({
        data: {
          provider,
          key,
          baseUrl:
            provider === 'ollama'
              ? String(form.get('baseUrl') || 'http://localhost:11434')
              : undefined,
        },
      })
      setSaved(display)
    } catch {
      setError('Could not save the key. It stays on this server either way.')
    } finally {
      setPending(false)
    }
  }

  if (saved) {
    return (
      <>
        <h1 className="mt-6 text-[22px] font-semibold tracking-tight">
          Key saved
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          Stored encrypted as{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{saved}</code>
          . It never leaves this server and is only decrypted at call time.
        </p>
        <Button className="mt-6 w-full" onClick={onDone}>
          Continue
        </Button>
      </>
    )
  }

  return (
    <>
      <h1 className="mt-6 text-[22px] font-semibold tracking-tight">
        Connect an AI provider
      </h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        Bring your own key — summaries, memo drafts, and tagging run through
        it. Optional: without one, AI features stay hidden and everything
        else works.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="provider">Provider</Label>
          <select
            id="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {provider === 'ollama' ? (
          <div className="space-y-1.5">
            <Label htmlFor="baseUrl">Ollama URL</Label>
            <Input
              id="baseUrl"
              name="baseUrl"
              type="url"
              defaultValue="http://localhost:11434"
            />
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="key">API key</Label>
          <Input
            id="key"
            name="key"
            type="password"
            autoComplete="off"
            placeholder={selected.placeholder}
          />
        </div>

        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" className="flex-1" disabled={pending}>
            {pending ? 'Saving…' : 'Save key'}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Skip for now
          </Button>
        </div>
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
        companies, a memo, a glossary, and a thesis with evidence on both
        sides. Obviously fictional, and safe to delete once you have seen how
        the pieces connect.
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
