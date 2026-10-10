import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ValueEditor } from './value-editor'
import type { RegistryEntry } from './value-editor'

/**
 * Money reads as money (2026-09-30). The deals table's Value column printed
 * `150000` because a currency cell fell through to the plain text editor,
 * which formatted only a `number` with a precision. The system `value`
 * attribute and a user-made currency attribute go through the same cell,
 * so both are pinned here, in both variants.
 */

const dealValue: RegistryEntry = {
  id: '00000000-0000-4000-8000-00000000000a',
  slug: 'value',
  name: 'Value',
  type: 'currency',
  isSystem: true,
  options: { code: 'USD' },
}

const ticketEur: RegistryEntry = {
  id: '00000000-0000-4000-8000-00000000000b',
  slug: 'ticket',
  name: 'Ticket',
  type: 'currency',
  isSystem: false,
  options: { code: 'EUR' },
}

function inputValue(
  def: RegistryEntry,
  value: unknown,
  variant: 'cell' | 'field',
) {
  const html = renderToStaticMarkup(
    <ValueEditor def={def} value={value} variant={variant} onSave={() => {}} />,
  )
  const m = /<input[^>]*\svalue="([^"]*)"/.exec(html)
  return { html, value: m?.[1] }
}

describe('ValueEditor — currency at rest', () => {
  it('prints the seeded deal Value as dollars, in a cell and in a field', () => {
    for (const variant of ['cell', 'field'] as const) {
      const { value, html } = inputValue(dealValue, 150000, variant)
      expect(value).toBe('$150,000')
      // At rest it is text; a number input could not hold "$150,000".
      expect(html).toContain('type="text"')
    }
  })

  it('prints a user-made currency attribute in its own currency', () => {
    expect(inputValue(ticketEur, 125000, 'cell').value).toBe('€125,000')
  })

  it('leaves an empty value empty, for the em-dash placeholder', () => {
    expect(inputValue(dealValue, null, 'cell').value).toBe('')
  })

  it('does not touch a plain number without a precision', () => {
    const founded: RegistryEntry = {
      slug: 'founded',
      name: 'Founded',
      type: 'number',
      isSystem: false,
      options: {},
    }
    expect(inputValue(founded, 1987, 'cell').value).toBe('1987')
  })
})

describe('ValueEditor — a person’s emails', () => {
  const emails: RegistryEntry = {
    slug: 'emails',
    name: 'Emails',
    type: 'email',
    isSystem: true,
    options: { multi: true, identityKey: 'email' },
  }
  const render = (def: RegistryEntry, value: Array<string>) =>
    renderToStaticMarkup(
      <ValueEditor def={def} value={value} variant="field" onSave={() => {}} />,
    )

  it('marks a role address as a shared inbox, and only that one', () => {
    const html = render(emails, ['info@acme.example', 'jane@acme.example'])
    expect(html).toContain('info@acme.example')
    expect(html.match(/shared inbox/g)).toHaveLength(1)
  })

  it('shows the first email in a property row and +N for the rest', () => {
    const html = render(emails, ['jane@acme.example', 'info@acme.example'])
    expect(html).toContain('jane@acme.example')
    expect(html).not.toContain('info@acme.example')
    expect(html).toContain('+1</span>')
  })

  it('leaves the mark off an email attribute that is not identity', () => {
    const plain: RegistryEntry = {
      ...emails,
      slug: 'billing',
      isSystem: false,
      options: { multi: true },
    }
    expect(render(plain, ['info@acme.example'])).not.toContain('shared inbox')
  })
})

const phone = (multi: boolean): RegistryEntry => ({
  slug: 'phone',
  name: 'Phone',
  type: 'phone',
  isSystem: true,
  options: multi ? { multi: true } : {},
})

describe('ValueEditor — phone (D67)', () => {
  it('reads a stored E.164 number grouped', () => {
    expect(inputValue(phone(false), '+14155550100', 'field').value).toBe(
      '+1 415 555 0100',
    )
  })

  it('a multi phone shows every number in a field, the first and +N in a cell', () => {
    const numbers = ['+919845012345', '+14155550100']
    const field = renderToStaticMarkup(
      <ValueEditor
        def={phone(true)}
        value={numbers}
        variant="field"
        onSave={() => {}}
      />,
    )
    expect(field).toContain('+91 98450 12345')
    expect(field).toContain('+1 415 555 0100')
    const cell = renderToStaticMarkup(
      <ValueEditor
        def={phone(true)}
        value={numbers}
        variant="cell"
        onSave={() => {}}
      />,
    )
    expect(cell).toContain('+91 98450 12345')
    expect(cell).not.toContain('+1 415 555 0100')
    expect(cell).toContain('+1</span>')
  })
})
