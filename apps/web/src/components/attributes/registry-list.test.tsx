import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { widenNote } from './attribute-dialog'
import { RegistryList, ruleWords } from './registry-list'
import type { RegistryAttr } from './registry-list'

/**
 * The attributes ledger: a system attribute's `···` has no Archive, a
 * user attribute's does.
 * - happy-dom's DOM globals are installed by hand before React loads, as in
 *   the other window tests.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/settings/objects/companies' })
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
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
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

const fns = vi.hoisted(() => ({
  createAttribute: vi.fn(),
  listObjects: vi.fn(),
  reorderAttributes: vi.fn(),
  updateAttribute: vi.fn(),
}))
vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
}))

const row = (over: Partial<RegistryAttr>): RegistryAttr => ({
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'description',
  name: 'Description',
  description: null,
  type: 'text',
  options: {},
  isSystem: false,
  archived: false,
  sortOrder: 10,
  filterable: false,
  sortable: false,
  pair: null,
  ...over,
})

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

async function mount(registry: Array<RegistryAttr>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() =>
    r.render(
      <RegistryList
        object={{
          id: '00000000-0000-4000-8000-0000000000c0',
          slug: 'companies',
          singular: 'Company',
          plural: 'Companies',
          isSystem: true,
        }}
        registry={registry}
        canReshape
        objectNames={new Map()}
        filledBy={new Map()}
      />,
    ),
  )
  await flush()
}

async function menuOf(name: string) {
  const trigger = document.querySelector(`[aria-label="More for ${name}"]`)
  if (trigger === null) throw new Error(`no ··· for ${name}`)
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await flush()
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
    el.textContent.trim(),
  )
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  await flush()
  return items
}

describe('the ledger row’s ··· (R1)', () => {
  it('offers no Archive on a system attribute and Archive on a user one', async () => {
    await mount([
      row({ name: 'Stage', slug: 'stage', isSystem: true }),
      row({
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Lead investor',
        slug: 'lead_investor',
        sortOrder: 20,
      }),
    ])
    const system = await menuOf('Stage')
    expect(system).toContain('Edit…')
    expect(system).not.toContain('Archive')
    expect(await menuOf('Lead investor')).toContain('Archive')
  })
})

describe('the ledger row', () => {
  it('opens its Edit window on a click, and leaves a click on its ··· to the menu', async () => {
    await mount([row({ name: 'Lead investor', slug: 'lead_investor' })])
    const li = document.querySelector('[data-attribute="lead_investor"]')
    if (!(li instanceof HTMLElement)) throw new Error('no row')
    // The name is text, not an inline field: the click is the row's.
    expect(li.querySelector('input')).toBeNull()
    act(() => {
      li.querySelector('[aria-label="More for Lead investor"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    act(() => {
      li.querySelector('span:not([aria-hidden])')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await flush()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('#attr-name')).not.toBeNull()
  })

  it('prints filter and sort in the rules lane only when they are set', async () => {
    expect(ruleWords(row({}), null)).toBe('')
    expect(ruleWords(row({ filterable: true }), null)).toBe('filter')
    expect(ruleWords(row({ filterable: true, sortable: true }), null)).toBe(
      'filter · sort',
    )
    await mount([
      row({ name: 'Stage', slug: 'stage', filterable: true, sortable: true }),
      row({
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Notes',
        slug: 'notes',
        sortOrder: 20,
      }),
    ])
    const rules = (slug: string) =>
      document.querySelector(`[data-attribute="${slug}"] [data-rules]`)
        ?.textContent
    expect(rules('stage')).toBe('filter · sort')
    expect(rules('notes')).toBe('')
  })
})

describe('the widening note (D69)', () => {
  const pair = { name: 'Fund', objectPlural: 'Funds' }
  it('says this side holds many and what the other half keeps', () => {
    // A 1:1 owner widens to 1:N: the derived half still holds one.
    expect(widenNote('Managers', pair, '1:1')).toBe(
      'Managers will each hold many Funds; Fund still holds one. This cannot be undone.',
    )
    // An N:1 owner widens to N:N: the other half already held many.
    expect(widenNote('Managers', pair, 'N:1')).toBe(
      'Managers will each hold many Funds; Fund already holds many. This cannot be undone.',
    )
    expect(widenNote('Companies', null, undefined)).toBe(
      'Every stored value becomes a one-item list. This cannot be undone.',
    )
  })
})
