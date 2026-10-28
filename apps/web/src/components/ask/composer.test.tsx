import { Window } from 'happy-dom'
import { act, useState } from 'react'
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
import type * as ThreadModule from './ask-thread'
import type { AskScopeChip } from '#/lib/ask/types'
import type * as PageScopeModule from '#/lib/ask/page-scope'

/**
 * Ask's composer edits the scope in place: the chips sit inside its box, ×
 * on one asks beyond it, and `@` adds one — mounted on a happy-dom `Window`
 * the way `/ask` holds its chips, with the finder stubbed.
 */

const fns = vi.hoisted(() => ({ searchAll: vi.fn() }))

vi.mock('#/lib/server-fns', () => ({
  askQuestion: vi.fn(),
  getAskThread: vi.fn(),
  saveAskAnswerAsNote: vi.fn(),
  applyAskCard: vi.fn(),
  skipAskCard: vi.fn(),
  actOnFindRow: vi.fn(),
  getSaveWatchSetup: vi.fn(),
  saveFindAsWatch: vi.fn(),
  previewAskRef: vi.fn(),
  searchAll: fns.searchAll,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useRouter: () => ({ navigate: () => Promise.resolve() }),
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let thread: typeof ThreadModule
let pageScope: typeof PageScopeModule
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
  thread = await import('./ask-thread')
  pageScope = await import('#/lib/ask/page-scope')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

beforeEach(() => {
  fns.searchAll.mockReset()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

const ACME = '00000000-0000-4000-8000-00000000000a'
const OPS = '00000000-0000-4000-8000-0000000000a1'

const exponent: AskScopeChip = {
  kind: 'record',
  id: ACME,
  name: 'Exponent',
  href: `/deals/${ACME}`,
}

/** The composer holding its chips the way `/ask` does. */
function Harness({ start }: { start: ReadonlyArray<AskScopeChip> }) {
  const [scope, setScope] = useState(start)
  const [draft, setDraft] = useState('')
  return (
    <>
      <thread.AskComposer
        value={draft}
        onChange={setDraft}
        onSend={() => {}}
        onMention={(chip) => setScope(pageScope.withMention(scope, chip))}
        scope={scope}
        onRemoveChip={(chip) =>
          setScope(
            scope.filter(
              (c) => pageScope.chipKey(c) !== pageScope.chipKey(chip),
            ),
          )
        }
        streaming={false}
        focus={0}
      />
      <output data-scope>{scope.map((c) => c.name).join(',')}</output>
    </>
  )
}

const chips = () =>
  [...document.querySelectorAll('[data-composer] [data-chip]')].map(
    (c) => c.textContent,
  )
const scopeNow = () => document.querySelector('[data-scope]')?.textContent ?? ''

const mount = (start: ReadonlyArray<AskScopeChip>) =>
  act(async () => root.render(<Harness start={start} />))

describe('the composer’s chips', () => {
  it('× on a chip asks beyond it: the chip leaves the box and the scope', async () => {
    await mount([exponent, pageScope.WEB_CHIP])
    expect(chips()).toEqual(['Exponent', 'Web'])
    const x = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Ask beyond Exponent"]',
    )
    await act(async () => x?.click())
    expect(chips()).toEqual(['Web'])
    expect(scopeNow()).toBe('Web')
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Leave the web out"]',
        )
        ?.click(),
    )
    expect(chips()).toEqual([])
    expect(document.querySelector('[data-chips]')).toBeNull()
  })

  it('@ adds a chip inside the box, before the web', async () => {
    fns.searchAll.mockResolvedValue([
      {
        id: OPS,
        kind: 'space',
        name: 'Property ops',
        objectSlug: null,
        rowKind: 'entity',
      },
    ])
    await mount([pageScope.WEB_CHIP])
    const field = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Ask"]',
    )
    if (field === null) throw new Error('no field')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        win.HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setter?.call(field, 'Find in @Prop')
      field.setSelectionRange(13, 13)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260))
    })
    expect(fns.searchAll).toHaveBeenCalledWith({ data: { q: 'Prop' } })
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    expect(chips()).toEqual(['Property ops', 'Web'])
    expect(scopeNow()).toBe('Property ops,Web')
    expect(field.value).toBe('Find in Property ops ')
  })
})
