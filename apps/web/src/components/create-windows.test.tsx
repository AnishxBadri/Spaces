import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { CreateCompanyDialog } from './create-company-dialog'
import { CreatePersonDialog } from './create-person-dialog'

/**
 * A create window asks only for identity: New company opens on its name and
 * domain with the rest behind `More fields ›`; New person's email names its
 * company through the server's identity lookup; a key another record holds
 * is refused in the window with the way to that record, and nothing is
 * created. Mounted in happy-dom, through Radix.
 */

await vi.hoisted(async () => {
  const { installHappyGlobals } = await import('#/test/happy-globals')
  installHappyGlobals()
})

const fns = vi.hoisted(() => ({
  findByIdentity: vi.fn(),
  createCompany: vi.fn(),
  createPerson: vi.fn(),
  listTemplates: vi.fn(() => Promise.resolve([])),
}))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) =>
    createElement('a', { href: to, ...rest }, children),
}))
vi.mock('sonner', () => ({ toast: () => undefined }))

const COMPANY_REGISTRY: Array<RegistryEntry> = [
  {
    slug: 'domains',
    name: 'Domains',
    type: 'text',
    options: { identityKey: 'domain', multi: true },
    isSystem: true,
  },
  {
    slug: 'description',
    name: 'Description',
    type: 'text',
    options: {},
    isSystem: true,
  },
]

const PERSON_REGISTRY: Array<RegistryEntry> = [
  {
    slug: 'emails',
    name: 'Emails',
    type: 'text',
    options: { identityKey: 'email', multi: true },
    isSystem: true,
  },
  {
    slug: 'job_title',
    name: 'Job title',
    type: 'text',
    options: {},
    isSystem: true,
  },
]

const NO_MATCH = { owner: null, company: null }

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  vi.clearAllMocks()
  fns.findByIdentity.mockResolvedValue(NO_MATCH)
  fns.createCompany.mockResolvedValue({ action: 'created', name: 'Acme' })
  fns.createPerson.mockResolvedValue({ action: 'created', name: 'Awais' })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const wait = (ms = 0) => act(() => new Promise((r) => setTimeout(r, ms)))

const dialog = () => {
  const el = document.querySelector('[role="dialog"]')
  if (el === null) throw new Error('no dialog')
  return el
}

const button = (label: string, within: ParentNode = document) => {
  const found = [...within.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === label,
  )
  if (found === undefined) throw new Error(`no button ${label}`)
  return found
}

const click = async (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await wait()
}

const input = (id: string) => {
  const el = document.getElementById(id)
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input ${id}`)
  return el
}

/** Types into a React-controlled input, then leaves it. */
const fill = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    'value',
  )?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  await wait()
}

const submit = async () => {
  const form = dialog().querySelector('form')
  if (form === null) throw new Error('no form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await wait()
}

async function mount(node: ReactNode, trigger: string) {
  host = document.createElement('div')
  document.body.append(host)
  const r = createRoot(host)
  root = r
  const client = new QueryClient()
  act(() =>
    r.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>),
  )
  await click(button(trigger))
  await wait()
}

const fields = () =>
  [...dialog().querySelectorAll('input')].filter((i) => i.type !== 'hidden')

describe('New company', () => {
  it('opens on two fields, focus in the first, the rest behind More fields', async () => {
    await mount(
      <CreateCompanyDialog registry={COMPANY_REGISTRY} />,
      'New company',
    )
    expect(fields().map((i) => i.id)).toEqual([
      'company-name',
      'company-domain',
    ])
    expect(document.activeElement?.id).toBe('company-name')
    await click(button('More fields ›', dialog()))
    expect(dialog().textContent).toContain('Description')
    // The domain has its own field; the identity attribute is never repeated.
    expect(dialog().textContent).not.toContain('Domains')
  })

  it('refuses a domain another record holds and links to it', async () => {
    fns.findByIdentity.mockResolvedValue({
      owner: {
        id: 'c1',
        name: 'Pixxel',
        kind: 'company',
        path: '/companies/c1',
      },
      company: null,
    })
    await mount(
      <CreateCompanyDialog registry={COMPANY_REGISTRY} />,
      'New company',
    )
    await fill(input('company-name'), 'Pixxel Space')
    await fill(input('company-domain'), 'pixxel.space')
    expect(fns.findByIdentity).toHaveBeenCalledWith({
      data: { key: 'domain', value: 'pixxel.space' },
    })
    const line = dialog().querySelector('[data-identity-match]')
    expect(line?.textContent).toContain('Pixxel already has this domain')
    const open = line?.querySelector('a')
    expect(open?.textContent).toBe('Open Pixxel')
    expect(open?.getAttribute('href')).toBe('/companies/c1')

    await submit()
    expect(fns.createCompany).not.toHaveBeenCalled()
  })
})

describe('New person', () => {
  it('infers the company from the email and creates under it', async () => {
    fns.findByIdentity.mockResolvedValue({
      owner: null,
      company: { id: 'orbital', name: 'Orbital' },
    })
    await mount(
      <CreatePersonDialog companies={[]} registry={PERSON_REGISTRY} />,
      'New person',
    )
    expect(fields().map((i) => i.id)).toEqual(['person-name', 'person-email'])
    await fill(input('person-name'), 'Awais Ahmed')
    await fill(input('person-email'), 'awais@orbital.co')
    expect(fns.findByIdentity).toHaveBeenCalledWith({
      data: { key: 'email', value: 'awais@orbital.co' },
    })
    // Set, and shown under More fields.
    await click(button('More fields ›', dialog()))
    expect(dialog().querySelector('#person-company')?.textContent).toContain(
      'Orbital',
    )

    await submit()
    expect(fns.createPerson).toHaveBeenCalledTimes(1)
    expect(fns.createPerson.mock.calls[0]?.[0]).toMatchObject({
      data: {
        name: 'Awais Ahmed',
        email: 'awais@orbital.co',
        companyId: 'orbital',
      },
    })
  })

  it('refuses an email another person holds', async () => {
    fns.findByIdentity.mockResolvedValue({
      owner: { id: 'p1', name: 'Ada', kind: 'person', path: '/people/p1' },
      company: null,
    })
    await mount(
      <CreatePersonDialog companies={[]} registry={PERSON_REGISTRY} />,
      'New person',
    )
    await fill(input('person-name'), 'Ada L')
    await fill(input('person-email'), 'ada@engine.io')
    expect(
      dialog().querySelector('[data-identity-match]')?.textContent,
    ).toContain('Ada already has this email')
    await submit()
    expect(fns.createPerson).not.toHaveBeenCalled()
  })
})
