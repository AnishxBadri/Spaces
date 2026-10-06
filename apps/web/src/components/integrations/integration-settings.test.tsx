import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { settingsJsonSchema } from '@spaces/sdk'
import { formValuesOf, settingsFormOf } from '#/lib/integrations/settings-form'
import {
  SecretFieldRow,
  SettingsFields,
  WebhookUrlRow,
} from './integration-settings'

/**
 * The generated card: one control per setting kind, a refused value inline
 * against its field, a manifest the form cannot draw said in one line, and a
 * saved key shown only as its redacted display.
 */

const form = settingsFormOf(
  settingsJsonSchema(
    z.object({
      cacheDays: z.int().min(0).max(3650).default(90).describe('days'),
      autoEnrich: z.boolean().default(false),
      region: z.enum(['us', 'eu']).default('us'),
      label: z.string().optional(),
    }),
  ),
)

const fields = (errors: { [key: string]: string } = {}) => {
  if (!form.ok) throw new Error(form.reason)
  return renderToStaticMarkup(
    <SettingsFields
      form={form}
      values={formValuesOf(form.fields, { cacheDays: 30 })}
      errors={errors}
      disabled={false}
      dirty={false}
      onChange={() => undefined}
      onSave={() => undefined}
    />,
  )
}

describe('SettingsFields', () => {
  it('draws a field for a number and a string, a switch for a boolean, a picker for an enum', () => {
    const html = fields()
    expect(html).toContain('Cache days')
    expect(html).toContain('value="30"')
    expect(html).toContain('days')
    expect(html).toContain('role="switch"')
    expect(html).toContain('Auto enrich')
    expect(html).toContain('Region')
    expect(html).toContain('>us<')
    expect(html).toContain('Label')
    expect(html).toContain('Save settings')
  })

  it('shows a refused value against its field, rose, with not saved', () => {
    const html = fields({ cacheDays: 'must be between 0 and 3650' })
    expect(html).toContain('must be between 0 and 3650 · not saved')
    expect(html).toContain('role="alert"')
    expect(html).toContain('bg-[var(--badge-rose)]')
    expect(html).toContain('aria-invalid="true"')
    expect(html.match(/badge-rose/g)).toHaveLength(1)
  })

  it('says why in one line when the manifest cannot be drawn', () => {
    const refused = settingsFormOf(
      settingsJsonSchema(z.object({ feeds: z.array(z.string()) })),
    )
    const html = renderToStaticMarkup(
      <SettingsFields
        form={refused}
        values={{}}
        errors={{}}
        disabled={false}
        dirty={false}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    )
    expect(html).toContain('setting feeds is an array')
    expect(html).not.toContain('<input')
  })
})

describe('SecretFieldRow', () => {
  const draw = (display: string | null) =>
    renderToStaticMarkup(
      <SecretFieldRow
        field={{ slot: 'credential', label: 'Apollo key', display }}
        value=""
        disabled={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onRemove={() => undefined}
      />,
    )

  it('a saved key reads as its redacted display, in a write-only field', () => {
    const html = draw('apo…9f3c')
    expect(html).toContain('Replace Apollo key')
    expect(html).toContain('Saved as apo…9f3c. Leave empty to keep it.')
    expect(html).toContain('type="password"')
    expect(html).toContain('value=""')
    expect(html).toContain('Remove')
  })

  it('no key yet offers the field and no Remove', () => {
    const html = draw(null)
    expect(html).toContain('Apollo key')
    expect(html).toContain('Not set yet')
    expect(html).not.toContain('Remove')
  })
})

describe('the webhook group', () => {
  it('the webhook secret field speaks of a secret, not a key', () => {
    const html = renderToStaticMarkup(
      <SecretFieldRow
        field={{
          slot: 'webhook',
          label: 'Hooked webhook secret',
          display: null,
        }}
        value=""
        disabled={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onRemove={() => undefined}
      />,
    )
    expect(html).toContain('Hooked webhook secret')
    expect(html).toContain('Paste the secret')
    expect(html).toContain('Save secret')
  })

  it('the webhook URL is a read-only line with Copy', () => {
    const url = 'https://deals.example.com/api/webhooks/0b5cbe3e'
    const html = renderToStaticMarkup(<WebhookUrlRow url={url} />)
    expect(html).toContain('Webhook URL')
    expect(html).toContain(url)
    expect(html).toContain('Copy')
    expect(html).not.toContain('<input')
  })
})
