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
  setBaseCurrency: vi.fn(async () => ({ ok: true })),
  removeDemoData: vi.fn(async () => ({ removed: 8, kept: 0 })),
  saveMailbox: vi.fn(async () => ({ queued: true })),
  setSensitivityDefault: vi.fn(
    async ({ data }: { data: { sensitivity: string } }) => data.sensitivity,
  ),
  revokeApiToken: vi.fn(async () => ({ ok: true })),
  updateObject: vi.fn(async () => ({ ok: true })),
  setMemberBanned: vi.fn(async () => ({ ok: true })),
  setMemberRole: vi.fn(async () => ({ ok: true })),
  createInvite: vi.fn(async () => ({
    url: 'http://localhost/join?token=once',
  })),
  revokeInvite: vi.fn(async () => ({ ok: true })),
  updateTemplate: vi.fn(async () => ({ ok: true })),
  createApiToken: vi.fn(async () => ({
    id: 't9',
    name: 'Claude Desktop',
    token: 'spc_plaintext_once',
    prefix: 'spc_plai',
    scopes: ['records:read'],
  })),
  disconnectConnection: vi.fn(
    async ({ data }: { data: { connectionId: string } }) => ({
      connectionId: data.connectionId,
      revoke: 'kept',
    }),
  ),
  saveEnrichmentOrder: vi.fn(async () => undefined),
  saveEnrichmentAuto: vi.fn(async () => undefined),
  saveEnrichmentReuse: vi.fn(async () => undefined),
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
    enrichment: await import('#/routes/_app/settings/enrichment'),
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

/** The workspace row the shell hands every page; a test may give it a logo. */
const workspace: { name: string; logo: string | null } = {
  name: 'Fund One',
  logo: null,
}

const shellData = (isAdmin: boolean) => ({
  me: {
    id: isAdmin ? 'u-admin' : 'u-member',
    role: isAdmin ? 'admin' : 'member',
  },
  isAdmin,
  workspace: { ...workspace },
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
  templates: [
    {
      id: '00000000-0000-4000-8000-0000000000e1',
      kind: 'note',
      objectKind: null,
      noteKind: null,
      name: 'Seed memo',
      body: {},
      suggestOn: ['company', 'deal'],
      archived: false,
    },
    {
      id: '00000000-0000-4000-8000-0000000000e2',
      kind: 'space',
      objectKind: null,
      noteKind: null,
      name: 'Market map',
      body: {},
      suggestOn: ['space'],
      archived: false,
    },
    {
      id: '00000000-0000-4000-8000-0000000000e3',
      kind: 'note',
      objectKind: null,
      noteKind: null,
      name: 'Old IC memo',
      body: {},
      suggestOn: [],
      archived: true,
    },
  ],
  invites: isAdmin
    ? [
        {
          id: '00000000-0000-4000-8000-0000000000e4',
          email: 'partner@fund.example',
          role: 'member',
          createdAt: ISO,
          expiresAt: new Date(Date.now() + 5 * 86_400_000 - 60_000),
        },
        {
          id: '00000000-0000-4000-8000-0000000000e5',
          email: null,
          role: 'member',
          createdAt: ISO,
          expiresAt: new Date(Date.now() + 2 * 86_400_000 - 60_000),
        },
      ]
    : [],
  integrations: 1,
  objects: [],
  fx: {
    baseCurrency: 'USD',
    rates: [
      { currency: 'EUR', date: '2026-10-01', rateToBase: 1.09 },
      { currency: 'GBP', date: '2026-09-15', rateToBase: 1.265 },
      { currency: 'EUR', date: '2026-07-01', rateToBase: 1.072 },
      { currency: 'EUR', date: '2026-04-01', rateToBase: 1.05 },
    ],
  },
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

const WEBSITE_ID = '00000000-0000-4000-8000-0000000000b1'
const EXA_ID = '00000000-0000-4000-8000-0000000000b2'
const ATTR_ID = '00000000-0000-4000-8000-0000000000d1'

/** The Enrichment page: Website, then Apollo on, Exa off; Employees unlinked. */
const enrichmentPage = {
  readouts: { fieldsWeek: 41, creditsToday: 3, review: 1 },
  sources: [
    {
      id: WEBSITE_ID,
      name: 'Website',
      builtIn: true,
      sends: 'nothing out · free',
      on: true,
      runnable: true,
      state: 'every new record',
      integrationId: null,
    },
    {
      id: PLUGIN_ID,
      name: 'Apollo',
      builtIn: false,
      sends: 'domain · email · LinkedIn URL',
      on: true,
      runnable: true,
      state: '3 / 100 credits today',
      integrationId: PLUGIN_ID,
    },
    {
      id: EXA_ID,
      name: 'Exa',
      builtIn: false,
      sends: 'domain',
      on: false,
      runnable: true,
      state: 'off',
      integrationId: EXA_ID,
    },
  ],
  auto: { scopes: ['deal'], spaces: [], options: [], paid: ['Apollo', 'Exa'] },
  reuse: { days: 90, stored: false },
  grids: [
    {
      kind: 'company',
      label: 'Companies',
      sources: [
        { id: WEBSITE_ID, name: 'Website' },
        { id: PLUGIN_ID, name: 'Apollo' },
        { id: EXA_ID, name: 'Exa' },
      ],
      rows: [
        {
          id: '00000000-0000-4000-8000-0000000000d0',
          slug: 'description',
          name: 'Description',
          description: null,
          type: 'text',
          options: { enrichmentKey: 'company.description' },
          filterable: false,
          isSystem: true,
          key: 'company.description',
          keyWord: 'description',
          cells: ['fills', 'next', 'none'],
          filledBy: 'Website',
        },
        {
          id: ATTR_ID,
          slug: 'employees',
          name: 'Employees',
          description: null,
          type: 'number',
          options: {},
          filterable: false,
          isSystem: false,
          key: null,
          keyWord: null,
          cells: ['none', 'none', 'none'],
          filledBy: null,
        },
      ],
    },
    { kind: 'person', label: 'People', sources: [], rows: [] },
  ],
  runs: [],
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
  enrichment: () => ({ page: enrichmentPage }),
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
      threadsToday: 3,
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
        membersConnected: 2,
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
const currency = () =>
  document.querySelector('button[aria-label="Base currency"]')
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

/** Opens a `···` (or any Radix menu) the way a keyboard does. */
async function openMenu(label: string) {
  const trigger = document.querySelector(`button[aria-label="${label}"]`)
  if (!(trigger instanceof HTMLElement)) throw new Error(`no ${label}`)
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const menuItem = (text: string) =>
  Array.from(
    document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'),
  ).find((item) => item.textContent.trim() === text)

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

  it.each(PATHS)(
    '%s heads the page with a sentence-case eyebrow, the title and the double rule, no sentence',
    async (path) => {
      await mount(path)
      const head = document.querySelector('[data-settings-head]')
      expect(head?.className).toContain('double-rule')
      expect(head?.className).not.toContain('border-b')
      const eyebrow = head?.querySelector('h1')?.previousElementSibling
      expect(eyebrow?.textContent).toMatch(
        /^Settings · [A-Z][a-z]+|^Settings · AI$/,
      )
      expect(eyebrow?.className).not.toContain('uppercase')
      // Nothing under the title but the member's read-only line.
      expect(
        head
          ?.querySelector('h1')
          ?.nextElementSibling?.hasAttribute('data-read-only') ?? true,
      ).toBe(true)
      // Groups are caps labels on a hairline, never the bone band.
      for (const group of document.querySelectorAll('[data-settings-group]'))
        expect(group.className).not.toContain('bg-bone')
      for (const h3 of document.querySelectorAll('section h3'))
        expect(h3.closest('.bg-bone')).toBeNull()
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

    await click(currency())
    await click(
      Array.from(document.querySelectorAll('[cmdk-item]')).find(
        (el) => el.textContent.trim() === 'EUR · Euro',
      ),
    )
    expect(currency()?.textContent).toContain('EUR · Euro')
    expect(bar()?.textContent).toContain('2 changes')

    await click(byText('Discard', bar() ?? document))
    expect(input('Workspace name').value).toBe('Fund One')
    expect(currency()?.textContent).toContain('USD · US dollar')
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
    '/settings/enrichment',
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
    await openMenu('More for laptop')
    await click(menuItem('Revoke…'))
    expect(dialog()?.textContent).toContain('Revoke laptop?')
    expect(dialog()?.textContent).toContain('It cannot come back')
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
    await openMenu('More for Priya')
    await click(menuItem('Suspend access…'))
    expect(dialog()?.textContent).toContain('Suspend Priya?')
    expect(dialog()?.textContent).toContain('cannot sign in until restored')
    expect(writes.setMemberBanned).not.toHaveBeenCalled()
  })
})

describe('General, by sheet 01', () => {
  const groups = () =>
    Array.from(document.querySelectorAll('[data-settings-group] h3')).map((h) =>
      h.textContent.trim(),
    )

  it('groups Identity (Logo, then Name) and Defaults under caps labels', async () => {
    await mount('/settings/general')
    expect(groups().slice(0, 2)).toEqual(['Identity', 'Defaults'])
    for (const h3 of document.querySelectorAll('[data-settings-group] h3'))
      expect(h3.className).toContain('field-label')
    const text = document.body.textContent
    expect(text.indexOf('Logo')).toBeLessThan(text.indexOf('Name'))
    expect(text.indexOf('Name')).toBeLessThan(text.indexOf('Base currency'))
  })

  it('offers Upload and no Remove while no logo is saved', async () => {
    await mount('/settings/general')
    expect(byText('Upload')).toBeDefined()
    expect(byText('Remove')).toBeUndefined()
  })

  it('offers Remove beside Upload once a logo is saved', async () => {
    workspace.logo = '/api/blob/logo'
    try {
      await mount('/settings/general')
      expect(byText('Upload')).toBeDefined()
      expect(byText('Remove')).toBeDefined()
    } finally {
      workspace.logo = null
    }
  })

  it('reads Base currency as a Select, USD · US dollar, with no hint, and saves the chosen code', async () => {
    await mount('/settings/general')
    expect(currency()?.textContent).toContain('USD · US dollar')
    const row = currency()?.closest('.border-b')
    expect(row?.textContent).not.toMatch(/re-prices|ledgers keep/)
    await click(currency())
    await click(
      Array.from(document.querySelectorAll('[cmdk-item]')).find(
        (el) => el.textContent.trim() === 'GBP · British pound',
      ),
    )
    await click(saveControls().at(0))
    expect(writes.setBaseCurrency).toHaveBeenCalledWith({
      data: { currency: 'GBP' },
    })
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
    // A caps label on a hairline, not a bone band.
    const head = Array.from(
      document.querySelectorAll('[data-settings-group]'),
    ).find((g) => g.textContent.includes("What's set up"))
    expect(head?.className).toContain('border-hairline')
    expect(head?.className).not.toContain('bg-bone')
    expect(head?.querySelector('h3')?.className).toContain('field-label')
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

describe('Integrations → Enrichment (D76)', () => {
  const rows = () =>
    Array.from(document.querySelectorAll('[data-block="sources"] li'))

  it('lists the sources in the stored order with what each sends', async () => {
    await mount('/settings/enrichment')
    expect(rows().map((r) => r.getAttribute('data-source'))).toEqual([
      'website',
      'Apollo',
      'Exa',
    ])
    const text = rows().map((r) => r.textContent)
    expect(text[0]).toContain('built in')
    expect(text[0]).toContain('sends nothing out · free')
    expect(text[1]).toContain('sends domain · email · LinkedIn URL')
    expect(text[2]).toContain('off')
  })

  it('writes the order at once: Apollo moved above the Website, Exa switched on', async () => {
    await mount('/settings/enrichment')
    await click(document.querySelector('button[aria-label="Move Apollo up"]'))
    expect(writes.saveEnrichmentOrder).toHaveBeenLastCalledWith({
      data: { ids: [PLUGIN_ID, WEBSITE_ID] },
    })
    await click(document.querySelector('button[aria-label="Ask Exa"]'))
    expect(writes.saveEnrichmentOrder).toHaveBeenLastCalledWith({
      data: { ids: [PLUGIN_ID, WEBSITE_ID, EXA_ID] },
    })
    expect(bar()?.getAttribute('data-shown')).toBe('false')
  })

  it('ticks a trigger at once, and collects the reuse days into the Save bar', async () => {
    await mount('/settings/enrichment')
    await click(document.querySelector('#auto-space'))
    expect(writes.saveEnrichmentAuto).toHaveBeenCalledWith({
      data: { scopes: ['deal', 'space'], spaces: [] },
    })
    await type(input('Re-use days'), '30')
    expect(bar()?.textContent).toContain('1 change')
    await click(saveControls().at(0))
    expect(writes.saveEnrichmentReuse).toHaveBeenCalledWith({
      data: { days: 30 },
    })
  })

  it('shows which source fills each linked attribute, and an unlinked one as not linked with Fill from…', async () => {
    await mount('/settings/enrichment')
    const grid = document.querySelector('#what-fills-what')
    const description = grid?.querySelector('[data-attribute="description"]')
    expect(description?.querySelectorAll('[data-cell="fills"]')).toHaveLength(1)
    const employees = grid?.querySelector('[data-attribute="employees"]')
    expect(employees?.textContent).toContain('yours')
    expect(employees?.textContent).toContain('not linked')
    expect(byText('Fill from…', employees ?? document)).toBeDefined()
  })
})

describe('the workspace and integration forms, by sheets 02, 05, 07 and 08', () => {
  const dialog = () => document.querySelector('[role="dialog"]')
  const groups = () =>
    Array.from(document.querySelectorAll('[data-settings-group]')).map((g) =>
      g.textContent.trim(),
    )

  it('Members: a People ledger with a role Select per row, Invite in the head, and the waiting invites', async () => {
    await mount('/settings/members')
    expect(groups()).toEqual(['People2', 'Waiting to join2'])
    const rows = Array.from(document.querySelectorAll('[data-member-row]'))
    expect(rows).toHaveLength(2)
    // You read your own role; another member's is a Select and a ···.
    expect(rows.at(0)?.querySelector('[role="combobox"]')).toBeNull()
    expect(rows.at(0)?.textContent).toContain('Admin')
    expect(
      rows.at(1)?.querySelector('button[aria-label="Role of Priya"]')
        ?.textContent,
    ).toContain('Member')
    expect(
      rows.at(1)?.querySelector('button[aria-label="More for Priya"]'),
    ).not.toBeNull()
    // No inline form row and no hint sentence.
    expect(document.querySelector('section input')).toBeNull()
    expect(document.body.textContent).not.toContain('within 7 days')

    const invites = Array.from(document.querySelectorAll('[data-invite-row]'))
    expect(invites.at(0)?.textContent).toContain('partner@fund.example')
    expect(invites.at(0)?.textContent).toContain('Member · expires in 5 days')
    expect(invites.at(1)?.textContent).toContain('Anyone with the link')
    expect(invites.at(1)?.textContent).toContain('one use · expires in 2 days')
    await openMenu('More for partner@fund.example')
    await click(menuItem('Revoke invite'))
    expect(writes.revokeInvite).toHaveBeenCalledWith({
      data: { id: '00000000-0000-4000-8000-0000000000e4' },
    })
  })

  it('Members: Invite opens a window of email and role, and shows the link once', async () => {
    await mount('/settings/members')
    const head = document.querySelector('[data-settings-head]')
    await click(byText('Invite', head ?? document))
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Invite')
    expect(dialog()?.textContent).not.toMatch(/\besc\b/)
    const email = document.querySelector('#invite-email')
    if (!(email instanceof HTMLInputElement)) throw new Error('no email')
    await type(email, 'maya@fund.example')
    await click(byText('Create invite', dialog() ?? document))
    expect(writes.createInvite).toHaveBeenCalledWith({
      data: { role: 'member', email: 'maya@fund.example' },
    })
    expect(dialog()?.textContent).toContain('http://localhost/join?token=once')
  })

  it('Members: a role change applies at once, without a confirm', async () => {
    await mount('/settings/members')
    await openMenu('More for Priya')
    await click(menuItem('Make admin'))
    expect(dialog()).toBeNull()
    expect(writes.setMemberRole).toHaveBeenCalledWith({
      data: { userId: 'u-member', role: 'admin' },
    })
  })

  it('Templates: Template, Kind and Offered first on lanes, then Archived with Restore', async () => {
    await mount('/settings/templates')
    expect(groups()).toEqual(['Templates2', 'Archived1'])
    const rows = Array.from(document.querySelectorAll('[data-template-row]'))
    expect(rows.map((r) => r.textContent)).toEqual([
      'Seed memoNoteCompaniesDeals+···',
      'Market mapSpace breakdownSpaces+···',
    ])
    await openMenu('Where Market map is offered first')
    await click(menuItem('People'))
    expect(writes.updateTemplate).toHaveBeenCalledWith({
      data: {
        id: '00000000-0000-4000-8000-0000000000e2',
        suggestOn: ['space', 'person'],
      },
    })
    await click(byText('Restore'))
    expect(writes.updateTemplate).toHaveBeenLastCalledWith({
      data: { id: '00000000-0000-4000-8000-0000000000e3', archived: false },
    })
  })

  it('API tokens: It may as sentences with the scope under each, Create token under the form, the plaintext once', async () => {
    await mount('/settings/tokens')
    expect(groups()).toEqual(['New token', 'Your tokens1 live · 0 revoked'])
    const scopes = Array.from(
      document.querySelectorAll('section label span.mono'),
    ).map((s) => s.textContent)
    expect(scopes).toEqual([
      'records:read',
      'suggestions:write',
      'capture:write',
    ])
    expect(document.body.textContent).not.toContain('None yet')
    await type(input('Token name'), 'Claude Desktop')
    await click(
      document.querySelector('button[aria-label="Read records you can see"]'),
    )
    await click(byText('Create token'))
    expect(writes.createApiToken).toHaveBeenCalledWith({
      data: { name: 'Claude Desktop', scopes: ['records:read'] },
    })
    const panel = document.querySelector('[data-created-token]')
    expect(panel?.textContent).toContain('Copy it now. Spaces shows it once.')
    expect(panel?.textContent).toContain('spc_plaintext_once')
    expect(byText('Copy command', panel ?? document)).toBeDefined()
  })

  it('Connection apps: GOOGLE with its members connected and sentence-case labels', async () => {
    await mount('/settings/connection-apps')
    expect(groups()).toEqual(['Google2 members connected'])
    const text = document.body.textContent
    for (const label of ['Redirect address', 'Client ID', 'Client secret'])
      expect(text).toContain(label)
    expect(text).toContain('●●●● set 10-09')
    await click(byText('Replace'))
    await type(input('Google client secret'), 'GOCSPX-new')
    expect(bar()?.textContent).toContain('1 change')
  })

  it('Email forwarding: Address · Since last check · Threads today, then Mail server, Check every, Secure', async () => {
    await mount('/settings/email-forwarding')
    const cells = Array.from(
      document.querySelectorAll('[data-readouts] > div'),
    ).map((c) => c.textContent)
    expect(cells).toEqual([
      'deals@fund.exampleAddress',
      '—Since last check',
      '3Threads today',
    ])
    const text = document.body.textContent
    for (const label of ['Mail server', 'Check every', 'Secure', 'Folder'])
      expect(text).toContain(label)
    for (const gone of ['IMAP server', 'Poll every', 'TLS'])
      expect(text).not.toContain(gone)
    // Test connection sits in the foot row, not a row of its own.
    const foot = document.querySelector('[data-mailbox-foot]')
    expect(byText('Test connection', foot ?? document)).toBeDefined()
    // Hints only where privacy is at stake.
    const hints = Array.from(
      document.querySelectorAll('section span.text-label.text-graphite'),
    )
      .filter((h) => h.closest('[data-readouts]') === null)
      .map((h) => h.textContent)
    expect(hints).toEqual([
      'What is forwarded here is shared with every member.',
      'Not your account password.',
    ])
  })

  it('Currency & FX: the title, and a range on each superseded rate, no two rows alike', async () => {
    await mount('/settings/currency')
    expect(document.querySelector('h1')?.textContent).toBe('Currency & FX')
    expect(groups()).toEqual(['Rates4 · 2 currencies'])
    const rows = Array.from(document.querySelectorAll('[data-fx-row]'))
    const clauses = rows.map((r) => r.lastElementChild?.textContent)
    expect(clauses).toEqual([
      'events from 10-01',
      'events from 09-15',
      'events 07-01 to 09-30',
      'events 04-01 to 06-30',
    ])
    expect(new Set(rows.map((r) => r.textContent)).size).toBe(rows.length)
    expect(document.body.textContent).not.toContain('superseded')
    expect(document.body.textContent).not.toContain('newest wins')
  })
})
