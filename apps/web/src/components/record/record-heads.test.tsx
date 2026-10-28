import { act } from 'react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RecordAction } from '#/lib/server-fns'
import type { RecordEnrichView } from './plugin-actions'

/**
 * Every record head is `[verb] [verb] [···]`: the exact verbs per kind, the
 * `···` on all seven, and nothing a head used to carry — Sensitive,
 * Summarize, Save as template, Note about this, a printed key. A plugin's
 * actions are only in the `···`, under its name, and a closed job is a
 * toast. Mounted on a happy-dom `Window` under a memory router.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies/flent' })
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'localStorage',
    'Node',
    'NodeFilter',
    'Element',
    'SVGElement',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'Text',
    'DocumentFragment',
    'ShadowRoot',
    'Event',
    'CustomEvent',
    'UIEvent',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'FocusEvent',
    'MutationObserver',
    'ResizeObserver',
    'DOMRect',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
    Reflect.set(globalThis, key, Reflect.get(win, key))
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      Reflect.set(globalThis, name, Reflect.get(win, name))
  Reflect.set(globalThis, 'self', win)
  Reflect.set(globalThis, 'scrollTo', () => {})
  Reflect.set(
    globalThis,
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

const fns = vi.hoisted(() => ({
  askWebSources: vi.fn(async () => []),
  enrichRecord: vi.fn(async () => ({ queued: true })),
  fireRecordAction: vi.fn(async () => ({ status: 'queued' })),
  logInteraction: vi.fn(),
  saveRecordAsTemplate: vi.fn(),
  searchEntities: vi.fn(async () => []),
  setEntitySensitive: vi.fn(),
  archiveRecord: vi.fn(async () => ({ on: '2026-10-28T10:00:00.000Z' })),
  restoreRecord: vi.fn(async () => ({ restored: true })),
}))
vi.mock('#/lib/server-fns', () => fns)

const toasts = vi.hoisted(() => {
  type Action = { label: string; onClick: () => void }
  const shown: Array<{ message: string; action?: Action; error?: true }> = []
  const toast = Object.assign(
    (message: string, opts?: { action?: Action }) => {
      shown.push(opts?.action ? { message, action: opts.action } : { message })
    },
    {
      error: (message: string) => shown.push({ message, error: true }),
      success: () => {},
    },
  )
  return { shown, toast }
})
vi.mock('sonner', () => ({ toast: toasts.toast }))

/** The record's status stream, fed by hand: what `/api/job-status` sends. */
class FakeEventSource {
  static readonly CLOSED = 2
  static opened: Array<FakeEventSource> = []
  readonly url: string
  readyState = 1
  private readonly listeners = new Map<
    string,
    Array<(message: { data: string }) => void>
  >()
  constructor(url: string) {
    this.url = url
    FakeEventSource.opened.push(this)
  }
  addEventListener(type: string, fn: (message: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) })
  }
}
Reflect.set(globalThis, 'EventSource', FakeEventSource)

const { createRoot } = await import('react-dom/client')
const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
  await import('@tanstack/react-router')
const heads = await import('./record-heads')
const { SpaceMenu } = await import('#/components/space-page')

let root: Root | null = null

beforeEach(() => {
  toasts.shown.length = 0
  FakeEventSource.opened = []
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <header>{node}</header> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await act(async () => {
    await router.load()
    root?.render(<RouterProvider router={router} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const text = (el: Element | null) => (el?.textContent ?? '').trim()

/** The head's verbs, in order: every button but the `···`. */
const verbs = () =>
  [...document.querySelectorAll('header button')]
    .filter((b) => !(b.getAttribute('aria-label') ?? '').startsWith('More for'))
    .map(text)

const more = (name: string) =>
  document.querySelector(`header [aria-label="More for ${name}"]`)

async function openMenu(name: string) {
  const trigger = more(name)
  if (trigger === null) throw new Error('no ··· trigger')
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** The open menu's rows, a rule as `—`, a group head in brackets. */
function rows(): Array<string> {
  const menu = document.querySelector('[role="menu"]')
  if (menu === null) throw new Error('no menu')
  return [...menu.children].map((el) =>
    el.getAttribute('role') === 'separator'
      ? '—'
      : el.hasAttribute('data-menu-group')
        ? `[${text(el)}]`
        : text(el),
  )
}

const ID = 'f1f0b6f2-7c1e-4f0a-9d2a-0000000000aa'
const normal = { sensitivity: 'normal' as const, own: false }
const enrich: RecordEnrichView = {
  sources: ['Website', 'Apollo'],
  onlyFree: false,
  sensitive: false,
  last: null,
  whereFrom: {},
  parked: null,
  audience: { isAdmin: true, admins: ['Anish'] },
  kind: 'company',
}
const exa: RecordAction = {
  integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000002',
  pluginId: 'exa',
  pluginName: 'Exa',
  actionId: 'find-similar',
  label: 'Find similar',
  queue: 'plugin.exa.findSimilar',
}
const apolloEnrich: RecordAction = {
  integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000001',
  pluginId: 'apollo',
  pluginName: 'Apollo',
  actionId: 'enrich-company',
  label: 'Enrich',
  queue: 'plugin.apollo.enrichCompany',
}

/** What no head carries any more. */
function expectQuietHead() {
  const head = text(document.querySelector('header'))
  for (const gone of [
    'Sensitive',
    'Summarize',
    'Save as template',
    'Note about this',
    'Note here',
    'Add watch',
  ])
    expect(head).not.toContain(gone)
  expect(document.querySelector('header kbd')).toBeNull()
  expect(document.querySelector('header [role="switch"]')).toBeNull()
}

describe('the record heads, all seven kinds', () => {
  it('company: Log interaction · Enrich · ···', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent', kind: 'company' }}
        enrich={enrich}
        sensitivity={normal}
        template="company"
        pluginActions={[apolloEnrich, exa]}
      />,
    )
    expect(verbs()).toEqual(['Log interaction', 'Enrich'])
    expect(more('Flent')).not.toBeNull()
    expectQuietHead()
  })

  it('person: Log interaction · Enrich · ···', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Priya Rao', kind: 'person' }}
        enrich={{ ...enrich, kind: 'person' }}
        sensitivity={normal}
        template="person"
      />,
    )
    expect(verbs()).toEqual(['Log interaction', 'Enrich'])
    expect(more('Priya Rao')).not.toBeNull()
    expectQuietHead()
  })

  it('deal: Log interaction · Move stage · ···', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent seed', kind: 'deal' }}
        verbs={<heads.MoveStageVerb onMove={() => {}} />}
        sensitivity={normal}
        template="deal"
      />,
    )
    expect(verbs()).toEqual(['Log interaction', 'Move stage'])
    expect(more('Flent seed')).not.toBeNull()
    expectQuietHead()
  })

  it('holding: Record a mark · Record a check · ···', async () => {
    await mount(
      <heads.HoldingHeadActions
        name="Flent"
        recordMark={(trigger) => trigger}
        recordCheck={(trigger) => trigger}
      />,
    )
    expect(verbs()).toEqual(['Record a mark', 'Record a check'])
    expect(more('Flent')).not.toBeNull()
    expectQuietHead()
  })

  it('custom object: Log interaction · ··· when it links people, else ··· alone', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Harbour Fund', kind: 'custom' }}
        sensitivity={normal}
      />,
    )
    expect(verbs()).toEqual(['Log interaction'])
    expect(more('Harbour Fund')).not.toBeNull()
    expectQuietHead()
    act(() => root?.unmount())
    document.body.replaceChildren()

    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Harbour Fund', kind: 'custom' }}
        log={false}
        sensitivity={normal}
      />,
    )
    expect(verbs()).toEqual([])
    expect(more('Harbour Fund')).not.toBeNull()
  })

  it('term: Write a note · ···', async () => {
    await mount(<heads.TermHeadActions name="NOI" onWriteNote={() => {}} />)
    expect(verbs()).toEqual(['Write a note'])
    expect(more('NOI')).not.toBeNull()
    expectQuietHead()
  })

  it('space: ··· only', async () => {
    const noop = () => {}
    await mount(
      <SpaceMenu
        id={ID}
        name="Property ops"
        criteria={null}
        archived={false}
        sensitivity={normal}
        onRename={noop}
        onSubspace={noop}
        onMove={noop}
        onTemplate={noop}
        onGlossary={noop}
        onArchive={noop}
        onRestore={noop}
      />,
    )
    expect(verbs()).toEqual([])
    expect(more('Property ops')).not.toBeNull()
    expectQuietHead()
    await openMenu('Property ops')
    expect(rows()).toEqual([
      'Find companiesAdd an Exa key ›',
      'Star',
      '—',
      'Rename',
      'Move to…',
      'Split into a subspace…',
      'Save as template…',
      'Glossary…',
      '—',
      'Sensitive',
      '—',
      'Archive',
    ])
  })
})

describe('the record ···', () => {
  it('holds Ask, Copy link, Save as template…, then Sensitive, then each plugin under its name', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent', kind: 'company' }}
        enrich={enrich}
        sensitivity={normal}
        template="company"
        pluginActions={[apolloEnrich, exa]}
      />,
    )
    await openMenu('Flent')
    // Apollo's own Enrich is the host's Enrich in the head: not offered twice.
    expect(rows()).toEqual([
      'Ask about this',
      'Copy link',
      'Save as template…',
      '—',
      'Sensitive',
      '—',
      'Archive',
      '—',
      '[Exa]',
      'Find similar',
    ])
  })

  it('an archived record: the ··· alone, with Restore where Archive was', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent', kind: 'company' }}
        enrich={enrich}
        sensitivity={normal}
        template="company"
        archived
      />,
    )
    expect(verbs()).toEqual([])
    await openMenu('Flent')
    expect(rows()).toContain('Restore')
    expect(rows()).not.toContain('Archive')
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => text(el) === 'Restore',
    )
    if (!(item instanceof HTMLElement)) throw new Error('no Restore')
    await act(async () => {
      item.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fns.restoreRecord).toHaveBeenCalledWith({ data: { id: ID } })
  })

  it('offers a source’s own action under its name where no host Enrich runs', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent seed', kind: 'deal' }}
        sensitivity={normal}
        pluginActions={[apolloEnrich, exa]}
      />,
    )
    await openMenu('Flent seed')
    expect(rows().slice(-6)).toEqual([
      '—',
      '[Apollo]',
      'Enrich',
      '—',
      '[Exa]',
      'Find similar',
    ])
  })

  it('names an inherited flag in Sensitive’s end lane', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent', kind: 'company' }}
        sensitivity={{
          sensitivity: 'sensitive',
          via: { kind: 'space', name: 'Fintech' },
          own: false,
        }}
      />,
    )
    await openMenu('Flent')
    expect(rows()).toContain('Sensitivevia Fintech')
  })

  it('fires a plugin action from the menu', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent', kind: 'company' }}
        pluginActions={[exa]}
      />,
    )
    await openMenu('Flent')
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => text(el) === 'Find similar',
    )
    if (!(item instanceof HTMLElement)) throw new Error('no Find similar')
    await act(async () => {
      item.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fns.fireRecordAction).toHaveBeenCalledWith({
      data: {
        integrationId: exa.integrationId,
        actionId: exa.actionId,
        entityId: ID,
      },
    })
  })
})

describe('the status stream on a record head', () => {
  const event = (over: object) => ({
    jobRunId: 'r1',
    queue: exa.queue,
    integrationId: exa.integrationId,
    entityId: ID,
    status: 'running',
    startedAt: '2026-10-26T10:00:00.000Z',
    summary: null,
    error: null,
    ...over,
  })

  it('toasts a plugin job that closes while the page is open, with Review when it left a card', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent', kind: 'company' }}
        pluginActions={[exa]}
      />,
    )
    const stream = FakeEventSource.opened.at(0)
    expect(stream?.url).toBe(`/api/job-status/${ID}`)
    act(() => {
      stream?.emit('init', { rows: [] })
      stream?.emit('status', event({}))
    })
    expect(toasts.shown).toEqual([])
    act(() => {
      stream?.emit(
        'status',
        event({ status: 'succeeded', summary: 'found 5 · brief in Review' }),
      )
    })
    expect(toasts.shown.map((t) => t.message)).toEqual([
      'Exa found 5 · brief in Review',
    ])
    expect(toasts.shown.at(0)?.action?.label).toBe('Review')
  })

  it('never toasts a row the stream replays on open', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent', kind: 'company' }}
        pluginActions={[exa]}
      />,
    )
    act(() => {
      FakeEventSource.opened.at(0)?.emit('init', {
        rows: [{ ...event({ status: 'succeeded' }), closedAgoMs: 1000 }],
      })
    })
    expect(toasts.shown).toEqual([])
  })

  it('reads Enriching… in graphite while the host Enrich runs', async () => {
    await mount(
      <heads.RecordHeadActions
        record={{ id: ID, name: 'Flent', kind: 'company' }}
        enrich={enrich}
      />,
    )
    act(() => {
      FakeEventSource.opened
        .at(0)
        ?.emit(
          'status',
          event({ queue: 'enrichment.run', integrationId: null }),
        )
    })
    expect(verbs()).toEqual(['Log interaction', 'Enriching…'])
    const button = document.querySelector('[data-enrich="running"]')
    expect(button?.className).toContain('text-graphite')
  })
})
