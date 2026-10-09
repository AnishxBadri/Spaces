import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import { settingsJsonSchema } from '@spaces/sdk'
import { formValuesOf, settingsFormOf } from '#/lib/integrations/settings-form'
import type * as RouterModule from '@tanstack/react-router'
import type { RouteComponent } from '@tanstack/react-router'

/**
 * The settings pages as D81 makes them behave, walked route by route under a
 * memory router whose ids mirror the app's (`_app` → `settings` → page):
 * - no page draws more than one Save, and that one is the page's Save bar;
 * - a typed field shows the bar with its count, Discard restores it, and a
 *   switch saves alone;
 * - a member reads the admin pages with every control disabled under the
 *   head's "Only admins can change this" line;
 * - the four acts that break something outside the page ask first, Keep
 *   focused.
 * The loaders here hand each page fixture data; the server fns a page writes
 * through are spies.
 */

const writes = vi.hoisted(() => ({
  saveWorkspace: vi.fn(async () => ({ ok: true })),
  removeDemoData: vi.fn(async () => ({ removed: 8, kept: 0 })),
  saveMailbox: vi.fn(async () => ({ queued: true })),
  setSensitivityDefault: vi.fn(
    async ({ data }: { data: { sensitivity: string } }) => data.sensitivity,
  ),
  revokeApiToken: vi.fn(async () => ({ ok: true })),
  updateObject: vi.fn(async () => ({ ok: true })),
  setMemberBanned: vi.fn(async () => ({ ok: true })),
  disconnectConnection: vi.fn(
    async ({ data }: { data: { connectionId: string } }) => ({
      connectionId: data.connectionId,
      revoke: 'kept',
    }),
  ),
}))

vi.mock('#/lib/server-fns', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...writes,
}))

vi.mock('sonner', () => ({
  toast: Object.assign(() => undefined, {
    error: () => undefined,
    success: () => undefined,
    message: () => undefined,
  }),
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let router: typeof RouterModule
const pages = new Map<string, RouteComponent>()

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('localStorage', win.localStorage)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('HTMLInputElement', win.HTMLInputElement)
  vi.stubGlobal('Element', win.Element)
  vi.stubGlobal('Node', win.Node)
  vi.stubGlobal('MouseEvent', win.MouseEvent)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  vi.stubGlobal('PointerEvent', win.PointerEvent)
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('FocusEvent', win.FocusEvent)
  vi.stubGlobal('CustomEvent', win.CustomEvent)
  // What Radix's dialog, focus scope and menu reach for.
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('MutationObserver', win.MutationObserver)
  vi.stubGlobal('ResizeObserver', win.ResizeObserver)
  vi.stubGlobal('DOMRect', win.DOMRect)
  vi.stubGlobal('NodeFilter', win.NodeFilter)
  vi.stubGlobal('HTMLButtonElement', win.HTMLButtonElement)
  vi.stubGlobal('HTMLTextAreaElement', win.HTMLTextAreaElement)
  vi.stubGlobal('HTMLSelectElement', win.HTMLSelectElement)
  vi.stubGlobal('SVGElement', win.SVGElement)
  vi.stubGlobal('ShadowRoot', win.ShadowRoot)
  vi.stubGlobal('DocumentFragment', win.DocumentFragment)
  vi.stubGlobal('requestAnimationFrame', win.requestAnimationFrame.bind(win))
  vi.stubGlobal('cancelAnimationFrame', win.cancelAnimationFrame.bind(win))
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  router = await import('@tanstack/react-router')
  const modules = {
    settings: await import('#/routes/_app/settings'),
    'email-calendar': await import('#/routes/_app/settings/email-calendar'),
    'email-calendar/$connectionId':
      await import('#/routes/_app/settings/email-calendar_.$connectionId'),
    files: await import('#/routes/_app/settings/files'),
    'files/$connectionId':
      await import('#/routes/_app/settings/files_.$connectionId'),
    'meeting-notes': await import('#/routes/_app/settings/meeting-notes'),
    tokens: await import('#/routes/_app/settings/tokens'),
    general: await import('#/routes/_app/settings/general'),
    members: await import('#/routes/_app/settings/members'),
    objects: await import('#/routes/_app/settings/objects'),
    'objects/$objectSlug':
      await import('#/routes/_app/settings/objects_.$objectSlug'),
    templates: await import('#/routes/_app/settings/templates'),
    currency: await import('#/routes/_app/settings/currency'),
    models: await import('#/routes/_app/settings/models'),
    search: await import('#/routes/_app/settings/search'),
    usage: await import('#/routes/_app/settings/usage'),
    plugins: await import('#/routes/_app/settings/plugins'),
    'plugins/$integrationId':
      await import('#/routes/_app/settings/plugins_.$integrationId'),
    'email-forwarding': await import('#/routes/_app/settings/email-forwarding'),
    'connection-apps': await import('#/routes/_app/settings/connection-apps'),
  }
  for (const [path, mod] of Object.entries(modules)) {
    const component = mod.Route.options.component
    if (component === undefined) throw new Error(`${path} has no component`)
    pages.set(path, component)
  }
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

beforeEach(() => {
  for (const spy of Object.values(writes)) spy.mockClear()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  // A focus scope returns focus on a timer after it unmounts; let it run
  // while the window's event classes are still the globals.
  await new Promise((resolve) => setTimeout(resolve, 0))
  document.body.replaceChildren()
})

// ---------------------------------------------------------------------------
// Fixtures: what each loader hands its page.
// ---------------------------------------------------------------------------

const ISO = '2026-10-09T12:00:00.000Z'
const OBJECT_ID = '00000000-0000-4000-8000-0000000000f1'
const PLUGIN_ID = '00000000-0000-4000-8000-0000000000a1'
const MAIL = '00000000-0000-4000-8000-0000000000c1'
const CALENDAR = '00000000-0000-4000-8000-0000000000c2'
const DRIVE = '00000000-0000-4000-8000-0000000000c3'
const DEALS_MAIL = '00000000-0000-4000-8000-0000000000c4'

const connection = (
  connectionId: string,
  product: string,
  externalEmail = 'anish@fund.example',
  connectedAt = '2026-10-01T09:00:00.000Z',
) => ({
  connectionId,
  provider: 'google' as const,
  product,
  externalEmail,
  scopes: [],
  status: 'active' as const,
  errorReason: null,
  lastSyncAt: null,
  connectedAt,
})

/** One Google address with Mail, Calendar and Drive; a later one with Mail. */
const accounts = {
  connections: [
    connection(MAIL, 'gmail'),
    connection(CALENDAR, 'calendar'),
    connection(DRIVE, 'drive'),
    connection(
      DEALS_MAIL,
      'gmail',
      'deals@fund.example',
      '2026-10-05T09:00:00.000Z',
    ),
  ],
  configured: ['google' as const],
  installed: ['calendar', 'google-drive'],
  offered: ['box'],
}

const shellData = (isAdmin: boolean) => ({
  me: {
    id: isAdmin ? 'u-admin' : 'u-member',
    role: isAdmin ? 'admin' : 'member',
  },
  isAdmin,
  workspace: { name: 'Fund One' },
  members: [
    {
      id: 'u-admin',
      name: 'Anish',
      email: 'a@fund.example',
      role: 'admin',
      banned: false,
    },
    {
      id: 'u-member',
      name: 'Priya',
      email: 'p@fund.example',
      role: 'member',
      banned: false,
    },
  ],
  templates: [],
  invites: [],
  integrations: 1,
  objects: [],
  fx: { baseCurrency: 'USD', rates: [] },
})

const pluginForm = settingsFormOf(
  settingsJsonSchema(
    z.object({
      cacheDays: z.int().min(0).max(3650).default(90),
      autoEnrich: z.boolean().default(false),
    }),
  ),
)

const pluginRow = {
  id: PLUGIN_ID,
  pluginId: 'apollo',
  name: 'Apollo',
  version: '1.0.0',
  roles: ['enrichment'],
  enabled: true,
  state: 'ok',
  reason: null,
  summary: null,
  lastRun: null,
  credits: { used: 0, cap: null },
  figure: '0 credits',
  autoEnrich: null,
  errorCount: 0,
  update: null,
  held: null,
  rollback: null,
}

const loaders: Record<string, () => object> = {
  general: () => ({
    demo: { total: 8, byKind: { company: 3, person: 1, term: 3, note: 1 } },
    setUp: {
      model: true,
      team: false,
      enrichment: true,
      forwarding: false,
      google: true,
      granola: false,
      exa: false,
    },
  }),
  'email-calendar': () => ({
    view: accounts,
    address: 'deals@in.fund.example',
  }),
  'email-calendar/$connectionId': () => ({ view: accounts }),
  files: () => ({ view: accounts }),
  'files/$connectionId': () => ({ view: accounts }),
  tokens: () => ({
    tokens: [
      {
        id: 't1',
        name: 'laptop',
        prefix: 'sp_abc',
        scopes: [],
        createdAt: ISO,
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
  }),
  'objects/$objectSlug': () => ({
    object: {
      id: OBJECT_ID,
      slug: 'funds',
      singular: 'Fund',
      plural: 'Funds',
      icon: null,
      identityKeys: ['domain'],
      hasRecords: false,
      isSystem: false,
      archived: false,
    },
    registry: [],
  }),
  models: () => ({
    providers: [
      {
        provider: 'anthropic',
        label: 'Anthropic',
        configured: true,
        status: 'active',
        display: 'set',
        baseUrl: null,
        headers: {},
        lastUsedAt: null,
        lastTestedAt: null,
        lastTestOk: null,
      },
    ],
    routes: [],
    sensitivityDefault: 'normal',
    embeddingPin: {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dims: 768,
      pinnedAt: ISO,
    },
  }),
  search: () => ({
    settings: { pin: null, slot: null, keys: [] },
    backfill: { pin: null },
  }),
  usage: () => ({
    usage: { runs: [], loneCalls: [] },
    run: null,
    asked: null,
    caps: {
      caps: { dailyTokens: 1000, perRunTokens: null },
      today: { used: 0, since: ISO, resetsAt: ISO },
    },
  }),
  plugins: () => ({
    rows: [pluginRow],
    registry: { available: [], error: null },
  }),
  'plugins/$integrationId': () => ({
    detail: {
      ...pluginRow,
      description: null,
      fix: null,
      form: pluginForm,
      values: pluginForm.ok
        ? formValuesOf(pluginForm.fields, { cacheDays: 30 })
        : {},
      secrets: [{ slot: 'credential', label: 'Apollo key', display: 'set' }],
      webhookUrl: null,
      autoEnrichForm: null,
      sends: ['domain', 'email', 'LinkedIn URL'],
      capabilities: [{ what: 'Fills company fields', owner: 'enrichment' }],
      runs: [],
    },
  }),
  'email-forwarding': () => ({
    settings: {
      mailbox: {
        address: 'deals@fund.example',
        host: 'imap.fund.example',
        port: 993,
        useTls: true,
        folder: 'INBOX',
        cadenceMinutes: 5,
        status: 'ok',
        lastError: null,
        lastPolledAt: null,
        passwordDisplay: 'set',
      },
      lastRun: null,
    },
  }),
  'connection-apps': () => ({
    apps: [
      {
        provider: 'google',
        label: 'Google',
        configured: true,
        clientId: 'client-1',
        secretDisplay: 'set',
        secretSetAt: ISO,
        redirectUri: 'http://localhost/api/connections/google/callback',
      },
    ],
  }),
}

/** Every page under the shell, as its URL. */
const PATHS = [
  ...Object.keys({ ...loaders }),
  'members',
  'objects',
  'templates',
  'currency',
  'meeting-notes',
]
  .map(
    (p) =>
      `/settings/${p.replace('$objectSlug', 'funds').replace('$integrationId', PLUGIN_ID).replace('$connectionId', DRIVE)}`,
  )
  .sort()

async function mount(path: string, isAdmin = true) {
  const {
    Outlet,
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
  } = router
  const rootRoute = createRootRoute()
  const app = createRoute({
    getParentRoute: () => rootRoute,
    id: '_app',
    component: () => <Outlet />,
  })
  const shell = pages.get('settings')
  const settings = createRoute({
    getParentRoute: () => app,
    path: 'settings',
    loader: () => shellData(isAdmin),
    ...(shell ? { component: shell } : {}),
  })
  const children = [...pages.entries()]
    .filter(([p]) => p !== 'settings')
    .map(([p, component]) => {
      const route = createRoute({
        getParentRoute: () => settings,
        path: p,
        component,
        ...(Object.hasOwn(loaders, p) ? { loader: loaders[p] } : {}),
      })
      // A drill-in page's id carries the `_` that keeps it out of its list's
      // component, as the generated tree's `update({ id, path })` gives it;
      // `createRoute` refuses both at once, and the id is read at build.
      if (p.includes('/'))
        Object.assign(route.options, {
          id: p
            .replace('objects/', 'objects_/')
            .replace('plugins/', 'plugins_/')
            .replace('email-calendar/', 'email-calendar_/')
            .replace('files/', 'files_/'),
        })
      return route
    })
  const r = createRouter({
    routeTree: rootRoute.addChildren([
      app.addChildren([settings.addChildren(children)]),
    ]),
    history: createMemoryHistory({
      initialEntries: [path],
    }),
  })
  await act(async () => {
    await r.load()
    root.render(<RouterProvider router={r} />)
  })
  return r
}

const buttons = () => Array.from(document.querySelectorAll('button'))
const saveControls = () =>
  buttons().filter((b) => /^sav(e|ing)/i.test(b.textContent.trim()))
const bar = () => document.querySelector('[data-save-bar]')

function input(label: string) {
  const el = document.querySelector(`input[aria-label="${label}"]`)
  if (!(el instanceof HTMLInputElement)) throw new Error(`no ${label}`)
  return el
}

/** Types into a controlled input the way React hears it. */
async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: Element | null | undefined) {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click')
  await act(async () => {
    el.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const byText = (text: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll('button')).find(
    (b) => b.textContent.trim() === text,
  )

// ---------------------------------------------------------------------------

describe('every settings page', () => {
  it.each(PATHS)(
    '%s draws at most one Save, and only the bar',
    async (path) => {
      await mount(path)
      expect(document.querySelector('h1')).not.toBeNull()
      const saves = saveControls()
      expect(saves.length).toBeLessThanOrEqual(1)
      for (const save of saves)
        expect(save.closest('[data-save-bar]')).not.toBeNull()
      expect(bar()?.getAttribute('data-shown')).toBe('false')
      // No footer strip: the "· admin only" caption lines are gone.
      expect(document.body.textContent).not.toMatch(/admin only/i)
    },
  )
})

describe('saving', () => {
  it('collects a typed field into the Save bar; Discard restores the stored value', async () => {
    await mount('/settings/general')
    const name = input('Workspace name')
    expect(name.value).toBe('Fund One')

    await type(name, 'Fund Two')
    expect(bar()?.getAttribute('data-shown')).toBe('true')
    expect(bar()?.textContent).toContain('1 change')

    await type(input('Base currency'), 'EUR')
    expect(bar()?.textContent).toContain('2 changes')

    await click(byText('Discard', bar() ?? document))
    expect(input('Workspace name').value).toBe('Fund One')
    expect(input('Base currency').value).toBe('USD')
    expect(bar()?.getAttribute('data-shown')).toBe('false')
    expect(writes.saveWorkspace).not.toHaveBeenCalled()
  })

  it('writes every dirty draft from the bar', async () => {
    await mount('/settings/general')
    await type(input('Workspace name'), 'Fund Two')
    const save = saveControls().at(0)
    await click(save)
    expect(writes.saveWorkspace).toHaveBeenCalledWith({
      data: { name: 'Fund Two' },
    })
    expect(bar()?.getAttribute('data-shown')).toBe('false')
  })

  it('saves a switch at once, without the bar', async () => {
    await mount('/settings/email-forwarding')
    const tls = document.querySelector('button[role="switch"]')
    await click(tls)
    expect(writes.saveMailbox).toHaveBeenCalledTimes(1)
    expect(writes.saveMailbox).toHaveBeenCalledWith({
      data: expect.objectContaining({
        useTls: false,
        host: 'imap.fund.example',
      }),
    })
    expect(bar()?.getAttribute('data-shown')).toBe('false')
  })
})

describe('a member on an admin page', () => {
  it.each([
    '/settings/models',
    '/settings/search',
    '/settings/plugins',
    `/settings/plugins/${PLUGIN_ID}`,
    '/settings/email-forwarding',
    '/settings/connection-apps',
  ])(
    '%s reads with every control disabled and says whom to ask',
    async (path) => {
      await mount(path, false)
      const line = document.querySelector('[data-read-only]')
      expect(line?.textContent).toBe('Only admins can change this · ask Anish')
      const section = document.querySelector('section')
      const controls = Array.from(
        section?.querySelectorAll('button, input, textarea, select') ?? [],
      )
      expect(controls.length).toBeGreaterThan(0)
      for (const c of controls)
        expect(
          c.closest('fieldset[disabled]'),
          `${c.tagName} ${c.getAttribute('aria-label') ?? c.textContent}`,
        ).not.toBeNull()
    },
  )

  it('reads a page members may change without the line', async () => {
    await mount('/settings/tokens', false)
    expect(document.querySelector('[data-read-only]')).toBeNull()
  })

  it('reads Caps disabled on Usage & limits, the run log open', async () => {
    await mount('/settings/usage', false)
    const lines = document.querySelectorAll('[data-read-only]')
    expect(lines).toHaveLength(1)
    expect(
      input('Daily token cap').closest('fieldset[disabled]'),
    ).not.toBeNull()
  })
})

describe('the four acts that break something elsewhere ask first', () => {
  const dialog = () => document.querySelector('[role="dialog"]')
  const focused = () => document.activeElement?.textContent.trim()

  it('revoking an API token', async () => {
    await mount('/settings/tokens')
    await click(byText('revoke'))
    expect(dialog()?.textContent).toContain('Revoke laptop?')
    expect(dialog()?.textContent).toContain('refused from its next call')
    expect(focused()).toBe('Keep')
    expect(writes.revokeApiToken).not.toHaveBeenCalled()
    await click(byText('Keep', dialog() ?? document))
    expect(writes.revokeApiToken).not.toHaveBeenCalled()
  })

  it('archiving an object', async () => {
    await mount('/settings/objects/funds')
    await click(byText('Archive'))
    expect(dialog()?.textContent).toContain('Archive Funds?')
    expect(dialog()?.textContent).toContain('pickers skip it')
    expect(focused()).toBe('Keep')
    expect(writes.updateObject).not.toHaveBeenCalled()
  })

  it('unticking an identity key', async () => {
    await mount('/settings/objects/funds')
    const domain = document.querySelector(
      'button[role="checkbox"][aria-checked="true"]',
    )
    await click(domain)
    expect(dialog()?.textContent).toContain('Stop matching funds on')
    expect(dialog()?.textContent).toContain('attribute is deleted')
    expect(focused()).toBe('Keep')
    expect(writes.updateObject).not.toHaveBeenCalled()
    await click(byText('Untick⌘↵', dialog() ?? document))
    expect(writes.updateObject).toHaveBeenCalledWith({
      data: { id: OBJECT_ID, identityKeys: [] },
    })
  })

  it('suspending a member', async () => {
    await mount('/settings/members')
    const trigger = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === 'member',
    )
    if (!(trigger instanceof HTMLElement)) throw new Error('no role menu')
    await act(async () => {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const suspend = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((item) => item.textContent.trim() === 'Suspend access')
    await click(suspend)
    expect(dialog()?.textContent).toContain('Suspend Priya?')
    expect(dialog()?.textContent).toContain('signed out on every device')
    expect(writes.setMemberBanned).not.toHaveBeenCalled()
  })
})

describe('General, after the first run (D80)', () => {
  const dialog = () => document.querySelector('[role="dialog"]')

  it('removes the demo only after a confirm naming its counts', async () => {
    await mount('/settings/general')
    await click(byText('Remove demo data'))
    expect(dialog()?.textContent).toContain('Remove the demo data?')
    expect(dialog()?.textContent).toContain('3 companies')
    expect(dialog()?.textContent).toContain('1 person')
    expect(writes.removeDemoData).not.toHaveBeenCalled()
    await click(byText('Remove demo data⌘↵', dialog() ?? document))
    expect(writes.removeDemoData).toHaveBeenCalledTimes(1)
  })

  it("lists the seven pieces in What's set up with their state and link", async () => {
    await mount('/settings/general')
    const text = document.body.textContent
    expect(text).toContain("What's set up")
    expect(text).toContain('3 of 7')
    for (const label of [
      'AI model',
      'Team',
      'Enrichment',
      'Email forwarding',
      'Google',
      'Granola',
      'Exa',
    ])
      expect(text).toContain(label)
    expect(
      document.querySelector('section a[href="/settings/meeting-notes"]')
        ?.textContent,
    ).toBe('Set up ›')
    expect(
      document.querySelector('section a[href="/settings/models"]')?.textContent,
    ).toBe('Open ›')
  })
})

describe('the accounts pages, by the job an account does', () => {
  const text = () => document.body.textContent
  const rowsNamed = (email: string) =>
    Array.from(document.querySelectorAll('a[aria-label]')).filter(
      (a) => a.getAttribute('aria-label') === `Options for ${email}`,
    )

  it('lists a Google address with Mail and Calendar once on Email & calendar, the earliest mail account as Default', async () => {
    await mount('/settings/email-calendar')
    expect(rowsNamed('anish@fund.example')).toHaveLength(1)
    expect(rowsNamed('deals@fund.example')).toHaveLength(1)
    expect(text()).toContain('Mail · Calendar')
    expect(
      document.querySelectorAll('[title="New email sends from this account"]'),
    ).toHaveLength(1)
    expect(text()).toContain('Connect Google')
    expect(text()).toContain('deals@in.fund.example')
    expect(
      document.querySelector('a[href="/settings/email-forwarding"]'),
    ).not.toBeNull()
  })

  it('lists the same address on Files for its Drive row', async () => {
    await mount('/settings/files')
    expect(rowsNamed('anish@fund.example')).toHaveLength(1)
    expect(rowsNamed('deals@fund.example')).toHaveLength(0)
    expect(rowsNamed('anish@fund.example')[0]?.getAttribute('href')).toBe(
      `/settings/files/${DRIVE}`,
    )
  })

  it('shows Install › to an admin and "Ask an admin" to a member for a plugin not installed', async () => {
    await mount('/settings/files')
    expect(
      document.querySelector('section a[href="/settings/plugins"]')
        ?.textContent,
    ).toBe('Install ›')
    expect(text()).not.toContain('Ask an admin')
    await mount('/settings/files', false)
    expect(
      document.querySelector('section a[href="/settings/plugins"]'),
    ).toBeNull()
    expect(text()).toContain('Ask an admin')
  })

  it('unticks Drive on the account page: a confirm naming what stays, then that row alone', async () => {
    const dialog = () => document.querySelector('[role="dialog"]')
    await mount(`/settings/files/${DRIVE}`)
    const ticks = Array.from(
      document.querySelectorAll('button[role="checkbox"]'),
    ).map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-checked')])
    expect(ticks).toEqual([
      ['Mail', 'true'],
      ['Calendar', 'true'],
      ['Drive', 'true'],
    ])
    await click(
      document.querySelector('button[role="checkbox"][aria-label="Drive"]'),
    )
    expect(dialog()?.textContent).toContain(
      'Stop using anish@fund.example for Drive?',
    )
    expect(dialog()?.textContent).toContain('Mail · Calendar stay connected')
    expect(writes.disconnectConnection).not.toHaveBeenCalled()
    const confirm = Array.from(dialog()?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent.trim().startsWith('Disconnect'),
    )
    await click(confirm)
    expect(writes.disconnectConnection).toHaveBeenCalledTimes(1)
    expect(writes.disconnectConnection).toHaveBeenCalledWith({
      data: { connectionId: DRIVE },
    })
  })

  it("ticks Calendar on an account without it: that product's own consent, for that address, back to the page", async () => {
    const assign = vi.spyOn(win.location, 'assign').mockImplementation(() => {})
    try {
      await mount(`/settings/email-calendar/${DEALS_MAIL}`)
      const calendar = document.querySelector(
        'button[role="checkbox"][aria-label="Calendar"]',
      )
      expect(calendar?.getAttribute('aria-checked')).toBe('false')
      await click(calendar)
      expect(assign).toHaveBeenCalledWith(
        `/api/connections/google/start?product=calendar&return=${encodeURIComponent(`/settings/email-calendar/${DEALS_MAIL}`)}&account=deals%40fund.example`,
      )
    } finally {
      assign.mockRestore()
    }
  })
})

describe('the AI pages, as D81 splits them', () => {
  it('Models opens on the sensitivity floor, and choosing Sensitive writes it at once', async () => {
    await mount('/settings/models')
    const heads = Array.from(document.querySelectorAll('h3')).map((h) =>
      h.textContent.trim(),
    )
    expect(heads.at(0)).toBe('Sensitivity')
    expect(document.body.textContent).toContain(
      'a floor · raises a record, never lowers it',
    )
    await click(
      document.querySelector('button[aria-label="Treat every record as"]'),
    )
    const sensitive = Array.from(document.querySelectorAll('[cmdk-item]')).find(
      (el) => el.textContent.trim() === 'Sensitive',
    )
    await click(sensitive)
    expect(writes.setSensitivityDefault).toHaveBeenCalledWith({
      data: { sensitivity: 'sensitive' },
    })
    expect(bar()?.getAttribute('data-shown')).toBe('false')
  })

  it('the routing grid has no Embed row, and one line pointing to Search', async () => {
    await mount('/settings/models')
    const lanes = Array.from(
      document.querySelectorAll('button[aria-label$=", normal"]'),
    ).map((b) => b.getAttribute('aria-label'))
    expect(lanes).toEqual([
      'extract lane, normal',
      'classify lane, normal',
      'synthesize lane, normal',
      'vision lane, normal',
      'research lane, normal',
    ])
    const link = document.querySelector('section a[href="/settings/search"]')
    expect(link?.textContent).toBe('set in Search ›')
    expect(link?.closest('li')?.textContent).toBe(
      'Embeddings · text-embedding-3-small · set in Search ›',
    )
  })

  it('Search names the Models key it reuses, and "Use a different key" asks for its own', async () => {
    const original = loaders.search
    loaders.search = () => ({
      settings: {
        pin: null,
        slot: null,
        keys: [
          {
            provider: 'openai',
            label: 'OpenAI',
            configured: true,
            source: 'models',
            display: 'sk-…0000',
            baseUrl: null,
            lastTestedAt: null,
            lastTestOk: null,
            testedModel: null,
          },
        ],
      },
      backfill: { pin: null },
    })
    try {
      await mount('/settings/search')
      expect(document.body.textContent).toContain(
        'using the OpenAI key from Models',
      )
      expect(
        document.querySelector('input[aria-label="OpenAI embedding API key"]'),
      ).toBeNull()
      await click(byText('Use a different key'))
      expect(input('OpenAI embedding API key').value).toBe('')
    } finally {
      loaders.search = original
    }
  })
})
