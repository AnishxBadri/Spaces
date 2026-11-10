import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import type { EditableAttribute } from '#/components/attributes/attribute-dialog'
import { ValueEditor } from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { ClockProvider } from '#/components/clock'
import { LongTextParagraph, LongTextParagraphs } from './long-text'
import { PropertyFold } from './property-fold'
import { RenamePersonDialog } from './rename-person'
import { PropertyCell, PropertyGrid } from './record-parts'

/**
 * A record's details, as the rail and Overview print them: values that are
 * never cut without their whole text in a `title`, a url that reads as a
 * link, and a long text attribute as an Overview paragraph that edits in
 * place — blur commits, Esc reverts.
 * - happy-dom's globals go in by hand before React loads, as in the other
 *   window tests.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies/x' })
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
    'HTMLTextAreaElement',
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

const updateAttribute = vi.hoisted(() =>
  vi.fn((_: unknown) => Promise.resolve({})),
)
vi.mock('#/lib/server-fns', () => ({
  listUsers: vi.fn(),
  searchEntities: vi.fn(),
  listObjects: vi.fn(() => Promise.resolve([])),
  createAttribute: vi.fn(() => Promise.resolve({})),
  updateAttribute,
}))

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

async function mount(node: ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() =>
    r.render(
      <ClockProvider now="2026-11-11T12:00:00.000Z">{node}</ClockProvider>,
    ),
  )
  await flush()
  return host
}

const fire = async (el: Element, event: Event) => {
  act(() => {
    el.dispatchEvent(event)
  })
  await flush()
}

/** React's controlled textarea reads its value through the native setter. */
function type(el: HTMLTextAreaElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    'value',
  )?.set
  act(() => {
    set?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const def = (
  type: string,
  options: RegistryEntry['options'] = null,
): RegistryEntry => ({
  slug: type,
  name: type,
  type,
  options,
  isSystem: false,
})

const classes = (el: Element | null) => (el?.className ?? '').split(/\s+/)

describe('the rail’s rows', () => {
  it('are unboxed: a 104px label lane that wraps, the value after it, a rule under each', async () => {
    const el = await mount(
      <PropertyGrid>
        <PropertyCell label="Founded">2019</PropertyCell>
        <PropertyCell label="A label long enough to wrap twice">x</PropertyCell>
      </PropertyGrid>,
    )
    const grid = el.querySelector('[data-property-grid]')
    // A rule over the first row, no box round them.
    expect(classes(grid)).toEqual(
      expect.arrayContaining(['border-t', 'border-rule']),
    )
    expect(classes(grid)).not.toContain('border')
    for (const label of el.querySelectorAll('[data-property-label]')) {
      expect(classes(label)).toEqual(
        expect.arrayContaining([
          'w-26',
          'shrink-0',
          'text-label',
          'text-graphite',
          'break-words',
        ]),
      )
      // No bone label column, no rule beside it, never cut.
      expect(classes(label)).not.toContain('bg-bone')
      expect(classes(label)).not.toContain('border-r')
      expect(label.outerHTML).not.toContain('truncate')
      const value = label.nextElementSibling
      expect(classes(value)).toEqual(
        expect.arrayContaining(['min-h-8', 'flex-1']),
      )
      expect(classes(value)).not.toContain('bg-paper')
      expect(classes(label.parentElement)).toEqual(
        expect.arrayContaining(['border-b', 'border-rule', 'flex-wrap']),
      )
    }
  })

  it('lets a mono value drop under its label: sized to its text, not to what is left', async () => {
    const el = await mount(
      <PropertyCell label="Domains" wide>
        bharatphotonics-industrial-lasers.co.in
      </PropertyCell>,
    )
    const value = el.querySelector('[data-property-value]')
    expect(classes(value)).toContain('flex-auto')
    expect(classes(value)).not.toContain('flex-1')
  })
})

describe('a value is never cut silently', () => {
  it('wraps a long text value in a growing textarea, never a one-line input', async () => {
    const long =
      'Fibre lasers for domestic manufacturing, sold to sheet-metal shops as a cheaper, locally serviced alternative to imported units.'
    const el = await mount(
      <ValueEditor
        def={def('text')}
        value={long}
        variant="field"
        onSave={() => undefined}
      />,
    )
    const area = el.querySelector('textarea')
    expect(area?.value).toBe(long)
    expect(classes(area)).toEqual(
      expect.arrayContaining(['break-words', 'resize-none', 'min-h-8']),
    )
    expect(el.querySelector('input')).toBeNull()
    expect(el.innerHTML).not.toContain('truncate')
  })

  it('cuts a long domain in the middle, whole in its title, chip-less', async () => {
    const long = 'bharatphotonics-industrial-lasers.co.in'
    const el = await mount(
      <ValueEditor
        def={def('domain', { multi: true })}
        value={['bharatphotonics.com', long]}
        variant="field"
        onSave={() => undefined}
      />,
    )
    const cut = el.querySelector(`[title="${long}"]`)
    expect(cut).not.toBeNull()
    // Head that ellipsizes, tail that stays: the suffix survives the cut.
    expect(cut?.lastElementChild?.textContent).toBe('ers.co.in')
    expect(cut?.textContent).toBe(long)
    // One value per line, no bordered chip at rest.
    expect(el.textContent).toContain('bharatphotonics.com')
    expect(el.querySelector('.border-rule.bg-paper')).toBeNull()
  })

  it('prints a single domain cut in the middle at rest, the input over it holding the whole value', async () => {
    const long = 'bharatphotonics-industrial-lasers.co.in'
    const el = await mount(
      <ValueEditor
        def={def('domain')}
        value={long}
        variant="field"
        onSave={() => undefined}
      />,
    )
    const input = el.querySelector('input')
    expect(input?.value).toBe(long)
    expect(input?.getAttribute('title')).toBe(long)
    expect(classes(input)).toContain('text-transparent')
    const rest = el.querySelector('[data-value-at-rest]')
    expect(rest?.querySelector(`[title="${long}"]`)?.textContent).toBe(long)
  })

  it('reads a url as host and path with an ↗ that opens it, and keeps the click on the value for editing', async () => {
    const url = 'https://www.bharatphotonics-industrial-lasers.co.in/about/'
    const el = await mount(
      <ValueEditor
        def={def('url')}
        value={url}
        variant="field"
        onSave={() => undefined}
      />,
    )
    const rest = el.querySelector('[data-value-at-rest]')
    expect(rest?.textContent).toBe(
      'bharatphotonics-industrial-lasers.co.in/about',
    )
    expect(el.querySelector('input')?.getAttribute('title')).toBe(url)
    const link = el.querySelector('a')
    expect(link?.getAttribute('href')).toBe(url)
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noreferrer')
    expect(link?.textContent).toBe('↗')
  })

  it('opens no link for anything but a web address', async () => {
    const el = await mount(
      <ValueEditor
        def={def('url')}
        value="javascript:alert(1)"
        variant="field"
        onSave={() => undefined}
      />,
    )
    expect(el.querySelector('a')).toBeNull()
  })
})

describe('a long text paragraph', () => {
  const text = 'Builds 1–6 kW fibre laser sources in Coimbatore.'

  it('prints its label and the text at the body step, clamped to three lines', async () => {
    const el = await mount(
      <LongTextParagraph
        def={{ slug: 'description', name: 'Description' }}
        text={text}
        open={false}
        onSave={() => Promise.resolve()}
      />,
    )
    expect(el.textContent).toContain('Description')
    const body = el.querySelector('[data-long-text-body]')
    expect(body?.textContent).toBe(text)
    expect(classes(body)).toContain('line-clamp-3')
    expect(classes(body?.parentElement ?? null)).toContain('text-body')
    expect(el.querySelector('textarea')).toBeNull()
  })

  it('opens a textarea in place on a click, commits on blur, with no Save button', async () => {
    const saved: Array<string | null> = []
    const el = await mount(
      <LongTextParagraph
        def={{ slug: 'description', name: 'Description' }}
        text={text}
        open={false}
        onSave={(v) => {
          saved.push(v)
          return Promise.resolve()
        }}
      />,
    )
    const body = el.querySelector('[data-long-text-body]')
    if (body === null) throw new Error('no body')
    await fire(body, new MouseEvent('click', { bubbles: true }))
    const area = el.querySelector('textarea')
    if (area === null) throw new Error('no editor')
    expect(area.value).toBe(text)
    expect(el.querySelectorAll('button')).toHaveLength(0)
    type(area, 'Pilot customers in Pune.')
    await fire(area, new FocusEvent('focusout', { bubbles: true }))
    expect(saved).toEqual(['Pilot customers in Pune.'])
    expect(el.querySelector('textarea')).toBeNull()
    expect(el.querySelector('[data-long-text-body]')?.textContent).toBe(
      'Pilot customers in Pune.',
    )
  })

  it('reverts on Esc and writes nothing', async () => {
    const saved: Array<string | null> = []
    const el = await mount(
      <LongTextParagraph
        def={{ slug: 'description', name: 'Description' }}
        text={text}
        open={false}
        onSave={(v) => {
          saved.push(v)
          return Promise.resolve()
        }}
      />,
    )
    const body = el.querySelector('[data-long-text-body]')
    if (body === null) throw new Error('no body')
    await fire(body, new MouseEvent('click', { bubbles: true }))
    const area = el.querySelector('textarea')
    if (area === null) throw new Error('no editor')
    type(area, 'Something else')
    await fire(
      area,
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await fire(area, new FocusEvent('focusout', { bubbles: true }))
    expect(saved).toEqual([])
    expect(el.querySelector('textarea')).toBeNull()
    expect(el.querySelector('[data-long-text-body]')?.textContent).toBe(text)
  })

  it('holds a refused write crimson and keeps the stored text', async () => {
    const el = await mount(
      <LongTextParagraph
        def={{ slug: 'description', name: 'Description' }}
        text={text}
        open={false}
        onSave={() => Promise.reject(new Error('description: too long'))}
      />,
    )
    const body = el.querySelector('[data-long-text-body]')
    if (body === null) throw new Error('no body')
    await fire(body, new MouseEvent('click', { bubbles: true }))
    const area = el.querySelector('textarea')
    if (area === null) throw new Error('no editor')
    type(area, 'x'.repeat(3000))
    await fire(area, new FocusEvent('focusout', { bubbles: true }))
    await flush()
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('too long')
    expect(el.querySelector('.border-destructive')).not.toBeNull()
    expect(el.querySelector('[data-long-text-body]')?.textContent).toBe(text)
  })

  it('shows Overview only the filled ones, and an empty one once the fold opens it, straight to its editor', async () => {
    const defs = [
      {
        slug: 'description',
        name: 'Description',
        type: 'text',
        options: { longText: true },
      },
      {
        slug: 'thesis',
        name: 'Thesis',
        type: 'text',
        options: { longText: true },
      },
      { slug: 'location', name: 'Location', type: 'text', options: {} },
    ]
    const values: Record<string, string | null> = {
      description: text,
      thesis: null,
      location: 'Pune',
    }
    const el = await mount(
      <LongTextParagraphs
        defs={defs}
        valueOf={(d) => values[d.slug]}
        opened={[]}
        onSave={() => Promise.resolve()}
      />,
    )
    const shown = () =>
      [...el.querySelectorAll('[data-long-text]')].map((s) =>
        s.getAttribute('data-long-text'),
      )
    expect(shown()).toEqual(['description'])
    act(() => root?.unmount())
    const opened = await mount(
      <LongTextParagraphs
        defs={defs}
        valueOf={(d) => values[d.slug]}
        opened={['thesis']}
        onSave={() => Promise.resolve()}
      />,
    )
    expect(
      [...opened.querySelectorAll('[data-long-text]')].map((s) =>
        s.getAttribute('data-long-text'),
      ),
    ).toEqual(['description', 'thesis'])
    expect(
      opened.querySelector('[data-long-text="thesis"] textarea'),
    ).not.toBeNull()
  })
})

describe('the fold and long text', () => {
  const defs = [
    { slug: 'location', name: 'Location', type: 'text', value: 'Pune' },
    { slug: 'description', name: 'Description', type: 'text', value: 'Sats' },
    { slug: 'thesis', name: 'Thesis', type: 'text', value: null },
  ]
  type Def = (typeof defs)[number]
  const away = (d: Def) => d.slug === 'description' || d.slug === 'thesis'

  it('never prints a long text as a row, offers an empty one, and sends its pick to Overview', async () => {
    const picked: Array<string> = []
    const el = await mount(
      <PropertyFold
        defs={defs}
        valueOf={(d) => d.value}
        render={(d) => (
          <p key={d.slug} data-row={d.slug}>
            {d.slug}
          </p>
        )}
        away={away}
        onPickAway={(d) => picked.push(d.slug)}
      />,
    )
    const rows = () =>
      [...el.querySelectorAll('[data-row]')].map((r) =>
        r.getAttribute('data-row'),
      )
    expect(rows()).toEqual(['location'])
    const foot = el.querySelector('[data-property-foot]')
    if (foot === null) throw new Error('no foot')
    expect(foot.textContent).toBe('1 empty+')
    await fire(foot, new MouseEvent('click', { bubbles: true }))
    const thesis = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Thesistext',
    )
    if (thesis === undefined) throw new Error('not offered')
    await fire(thesis, new MouseEvent('click', { bubbles: true }))
    expect(picked).toEqual(['thesis'])
    expect(rows()).toEqual(['location'])
  })
})

describe('the attribute window’s Long text switch', () => {
  const attr = (type: EditableAttribute['type'], longText?: boolean) => ({
    id: `00000000-0000-4000-8000-0000000000${type === 'text' ? '01' : '02'}`,
    name: 'Thesis',
    slug: 'thesis',
    type,
    options: longText === undefined ? {} : { longText },
  })
  const longSwitch = () =>
    [...document.querySelectorAll('[role="switch"]')].find(
      (s) => s.textContent === 'Long text',
    )

  it('appears for a text attribute only, reading the stored flag', async () => {
    await mount(
      <AttributeDialog
        mode="edit"
        open
        attr={attr('text', true)}
        objectPlural="Companies"
        onSaved={() => undefined}
      />,
    )
    expect(longSwitch()?.getAttribute('aria-checked')).toBe('true')
    act(() => root?.unmount())
    await mount(
      <AttributeDialog
        mode="edit"
        open
        attr={attr('number')}
        objectPlural="Companies"
        onSaved={() => undefined}
      />,
    )
    expect(longSwitch()).toBeUndefined()
  })

  it('saves the switch as the attribute’s longText', async () => {
    await mount(
      <AttributeDialog
        mode="edit"
        open
        attr={attr('text')}
        objectPlural="Companies"
        onSaved={() => undefined}
      />,
    )
    const toggle = longSwitch()
    if (toggle === undefined) throw new Error('no switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await fire(toggle, new MouseEvent('click', { bubbles: true }))
    const form = document.querySelector('form')
    if (form === null) throw new Error('no form')
    await fire(form, new Event('submit', { bubbles: true, cancelable: true }))
    const sent = updateAttribute.mock.calls.at(-1)?.[0]
    expect(sent).toMatchObject({ data: { config: { longText: true } } })
  })
})

describe('renaming a person', () => {
  it('writes the name’s two parts from the head’s window', async () => {
    const saved: Array<unknown> = []
    await mount(
      <RenamePersonDialog
        open
        onOpenChange={() => undefined}
        first="Selvam"
        last="Raj"
        onSave={(name) => {
          saved.push(name)
          return Promise.resolve()
        }}
      />,
    )
    const first = document.querySelector<HTMLInputElement>('#rename-first')
    const last = document.querySelector<HTMLInputElement>('#rename-last')
    expect(first?.value).toBe('Selvam')
    expect(last?.value).toBe('Raj')
    const form = document.querySelector('form')
    if (form === null) throw new Error('no form')
    await fire(form, new Event('submit', { bubbles: true, cancelable: true }))
    expect(saved).toEqual([{ first_name: 'Selvam', last_name: 'Raj' }])
  })
})
