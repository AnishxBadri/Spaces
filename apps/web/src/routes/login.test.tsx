import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Route } from './login'

/**
 * The sign-in page's answer to a refused attempt, mounted in happy-dom with
 * Better Auth's client stubbed: the rate limit's 429 is its own line, a
 * crimson square and one sentence, and a wrong password is the other.
 */

await vi.hoisted(async () => {
  const { installHappyGlobals } = await import('#/test/happy-globals')
  const win = installHappyGlobals('http://localhost/login')
  // The page reads its fields through `new FormData(form)`, which only
  // happy-dom's FormData accepts a happy-dom form for.
  Reflect.set(globalThis, 'FormData', Reflect.get(win, 'FormData'))
})

const client = vi.hoisted(() => ({
  signInEmail: vi.fn<() => Promise<{ error: { status: number } | null }>>(),
}))

vi.mock('#/lib/auth-client', () => ({
  authClient: { signIn: { email: client.signInEmail } },
}))
vi.mock('#/lib/server-fns', () => ({
  getSession: vi.fn(),
  getSetupState: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useSearch: () => ({}),
    useRouteContext: () => ({ workspaceName: 'Acme Ventures' }),
  }),
  redirect: vi.fn(),
  useNavigate: () => vi.fn(),
}))

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function submitWith(status: number): Promise<HTMLElement | null> {
  client.signInEmail.mockResolvedValue({ error: { status } })
  const Login = Route.options.component
  if (Login === undefined) throw new Error('no login component')
  const host = document.createElement('div')
  document.body.append(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<Login />))
  const form = document.querySelector('form')
  if (form === null) throw new Error('no form')
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return document.querySelector('[role="alert"]')
}

describe('the sign-in page', () => {
  it('says a 429 plainly, as a crimson square and one sentence', async () => {
    const alert = await submitWith(429)
    expect(alert?.textContent).toBe('Too many attempts. Try again in a minute.')
    expect(alert?.querySelector('span.bg-destructive')).not.toBeNull()
    // The reset hint is for a wrong password, not for being held off.
    expect(document.body.textContent).not.toContain('Forgot it?')
  })

  it('says a wrong password as the other line', async () => {
    const alert = await submitWith(401)
    expect(alert?.textContent).toBe('Wrong email or password.')
  })
})
