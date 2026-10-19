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
import type * as HeadModule from './save-as-watch'
import type { AskFindTable, SpaceWatching } from '#/lib/server-fns'

/**
 * Save as watch on a Find table, mounted on a happy-dom `Window` with the
 * server fns stubbed: the window prefilled from the turn, Weekly, the space
 * asked for when the turn had none, the line once saved, and "Already
 * watching this" landing on the existing watch. (D77)
 */

const fns = vi.hoisted(() => {
  const shown: Array<string> = []
  return {
    getSaveWatchSetup: vi.fn(),
    saveFindAsWatch: vi.fn(),
    navigate: vi.fn(async () => {}),
    shown,
  }
})

vi.mock('#/lib/server-fns', () => ({
  addSpaceWatch: vi.fn(),
  runWatchNow: vi.fn(),
  getSaveWatchSetup: fns.getSaveWatchSetup,
  saveFindAsWatch: fns.saveFindAsWatch,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode
    to: string
    className?: string
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useRouter: () => ({ navigate: fns.navigate, invalidate: () => {} }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign((m: string) => fns.shown.push(m), {
    error: (m: string) => fns.shown.push(`error: ${m}`),
  }),
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let head: typeof HeadModule
let root: Root

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('CustomEvent', win.CustomEvent)
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      vi.stubGlobal(name, Reflect.get(win, name))
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  head = await import('./save-as-watch')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

beforeEach(() => {
  fns.shown.length = 0
  fns.getSaveWatchSetup.mockReset()
  fns.saveFindAsWatch.mockReset()
  fns.navigate.mockClear()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

const EXA = '00000000-0000-4000-8000-0000000000e1'
const OPS = '00000000-0000-4000-8000-0000000000a1'
const TURN = '00000000-0000-4000-8000-0000000000t1'
const QUESTION = 'Find property management operators in Pune'

const exa: SpaceWatching['engines'][number] = {
  integrationId: EXA,
  name: 'Exa',
  form: {
    ok: true,
    fields: [
      {
        kind: 'string',
        key: 'criteria',
        label: 'Criteria',
        hint: null,
        required: false,
        default: null,
        minLength: null,
        maxLength: null,
        pattern: null,
        format: null,
      },
      {
        kind: 'number',
        key: 'cap',
        label: 'Cap',
        hint: null,
        required: false,
        default: 10,
        integer: true,
        minimum: 1,
        maximum: 100,
        exclusiveMinimum: null,
        exclusiveMaximum: null,
      },
    ],
  },
}

const setup = (criteria: string | null = null) => ({
  engines: [exa],
  installed: ['Exa'],
  spaces: [{ id: OPS, name: 'Property ops', depth: 0, criteria }],
})

const table = (scoped: boolean): AskFindTable => ({
  space: scoped ? { id: OPS, name: 'Property ops' } : null,
  rows: [
    {
      name: 'Alpha Estates',
      domain: 'alpha-estates.in',
      line: 'Runs buildings',
      place: 'Pune',
      sources: [{ url: 'https://alpha-estates.in/' }],
      via: { integrationId: EXA, name: 'Exa' },
      standing: 'unknown',
      entityId: null,
    },
  ],
  hidden: 0,
})

const text = (el: Element | null) => (el?.textContent ?? '').trim()

const buttonNamed = (name: RegExp) => {
  const hit = Array.from(document.querySelectorAll('button')).find((b) =>
    name.test(b.getAttribute('aria-label') ?? text(b)),
  )
  if (!hit) throw new Error(`no button ${name}`)
  return hit
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

const mount = async (t: AskFindTable) => {
  await act(async () =>
    root.render(
      <head.FindTableHead
        table={t}
        turnId={TURN}
        callIndex={1}
        question={QUESTION}
      />,
    ),
  )
  await settle()
}

const dialog = () => document.querySelector('[role="dialog"]')
const lookFor = () =>
  dialog()?.querySelector<HTMLInputElement>('input[id$="criteria"]') ?? null

describe('Save as watch', () => {
  it('opens on the scope’s space, Weekly, the question in Look for, and saves to that space', async () => {
    fns.getSaveWatchSetup.mockResolvedValue(setup())
    fns.saveFindAsWatch.mockResolvedValue({
      status: 'saved',
      watchId: 'w1',
      spaceId: OPS,
      spaceName: 'Property ops',
      cards: 9,
    })
    await mount(table(true))
    await act(async () => buttonNamed(/^Save as watch$/).click())
    expect(text(dialog()?.querySelector('h2') ?? null)).toBe('Save as watch')
    expect(text(dialog())).toContain('Property ops')
    const labels = Array.from(dialog()?.querySelectorAll('label') ?? []).map(
      (l) => text(l),
    )
    expect(labels).toEqual(['Engine', 'Look for', 'How often', 'At most'])
    expect(
      text(dialog()?.querySelector('[aria-label="How often"]') ?? null),
    ).toBe('Weekly')
    expect(lookFor()?.value).toBe(QUESTION)
    await act(async () => buttonNamed(/^Save watch/).click())
    await settle()
    expect(fns.saveFindAsWatch).toHaveBeenCalledWith({
      data: {
        turnId: TURN,
        callIndex: 1,
        space: { id: OPS },
        integrationId: EXA,
        values: { criteria: QUESTION, cap: '10' },
        cadenceMinutes: 10080,
      },
    })
    expect(fns.shown).toEqual([
      'Saved as a watch on Property ops · 9 in Review',
    ])
    expect(text(document.querySelector('[data-saved-watch="live"]'))).toBe(
      'Saved as a watch on Property ops',
    )
    expect(() => buttonNamed(/^Save as watch$/)).toThrow()
  })

  it('leaves Look for blank when the question is the space’s criteria', async () => {
    fns.getSaveWatchSetup.mockResolvedValue(setup(QUESTION))
    await mount(table(true))
    await act(async () => buttonNamed(/^Save as watch$/).click())
    expect(lookFor()?.value).toBe('')
  })

  it('asks for a space when the turn had none, and Save waits for one', async () => {
    fns.getSaveWatchSetup.mockResolvedValue(setup())
    await mount(table(false))
    await act(async () => buttonNamed(/^Save as watch$/).click())
    const labels = Array.from(dialog()?.querySelectorAll('label') ?? []).map(
      (l) => text(l),
    )
    expect(labels).toEqual([
      'Space',
      'Engine',
      'Look for',
      'How often',
      'At most',
    ])
    expect(buttonNamed(/^Save watch/).disabled).toBe(true)
  })

  it('opens the existing watch with "Already watching this"', async () => {
    fns.getSaveWatchSetup.mockResolvedValue(setup())
    fns.saveFindAsWatch.mockResolvedValue({
      status: 'exists',
      watchId: 'w0',
      spaceId: OPS,
      spaceName: 'Property ops',
    })
    await mount(table(true))
    await act(async () => buttonNamed(/^Save as watch$/).click())
    await act(async () => buttonNamed(/^Save watch/).click())
    await settle()
    expect(fns.shown).toEqual(['Already watching this'])
    expect(fns.navigate).toHaveBeenCalledWith({
      to: '/spaces/$spaceId',
      params: { spaceId: OPS },
      search: { watch: 'w0' },
    })
    expect(document.querySelector('[data-saved-watch]')).toBeNull()
  })

  it('is absent until a watch engine is installed', async () => {
    fns.getSaveWatchSetup.mockResolvedValue({
      engines: [],
      installed: [],
      spaces: [],
    })
    await mount(table(true))
    expect(() => buttonNamed(/^Save as watch$/)).toThrow()
  })
})
