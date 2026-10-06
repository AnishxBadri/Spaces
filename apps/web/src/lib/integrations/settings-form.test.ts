import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { settingsJsonSchema } from '@spaces/sdk'
import {
  checkSettings,
  formValuesOf,
  labelOf,
  mergeConfig,
  settingsFormOf,
} from './settings-form'

/**
 * The generated settings form: a manifest's emitted JSON Schema becomes
 * string, number, boolean and enum fields, anything else refuses the form,
 * and a save is checked field by field before anything is written. The
 * schemas are emitted by the sdk's own `settingsJsonSchema`, exactly as the
 * plugin build writes them into `manifest.json`.
 */

/** Apollo's settings, as its manifest authors them. */
const apollo = settingsJsonSchema(
  z.object({
    cacheDays: z.int().min(0).max(3650).default(90),
    dailyCreditCap: z.int().min(0).default(100),
    autoEnrich: z.boolean().default(false),
  }),
)

const fieldsOf = (settings: unknown) => {
  const form = settingsFormOf(settings)
  if (!form.ok) throw new Error(form.reason)
  return form.fields
}

describe('settingsFormOf', () => {
  it('draws string, number, boolean and enum fields in declaration order', () => {
    const fields = fieldsOf(
      settingsJsonSchema(
        z.object({
          region: z.enum(['us', 'eu']).default('us'),
          label: z.string().min(2).describe('Shown on every receipt'),
          ratio: z.number().gt(0),
          cacheDays: z.int().min(0).max(3650).default(90),
          live: z.boolean().default(true),
          contact: z.email().optional(),
          endpoint: z.url().optional(),
        }),
      ),
    )
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ['region', 'enum'],
      ['label', 'string'],
      ['ratio', 'number'],
      ['cacheDays', 'number'],
      ['live', 'boolean'],
      ['contact', 'string'],
      ['endpoint', 'string'],
    ])
    expect(fields[0]).toMatchObject({
      label: 'Region',
      options: ['us', 'eu'],
      default: 'us',
      required: false,
    })
    expect(fields[1]).toMatchObject({
      label: 'Label',
      hint: 'Shown on every receipt',
      required: true,
      minLength: 2,
    })
    expect(fields[3]).toMatchObject({
      label: 'Cache days',
      integer: true,
      minimum: 0,
      maximum: 3650,
      default: 90,
      required: false,
    })
  })

  it('draws a plugin with no settings as no fields', () => {
    expect(settingsFormOf({})).toEqual({ ok: true, fields: [] })
    expect(settingsFormOf(settingsJsonSchema(z.object({})))).toEqual({
      ok: true,
      fields: [],
    })
  })

  it.each([
    ['an array', z.object({ feeds: z.array(z.string()) }), 'feeds', 'array'],
    [
      'an object',
      z.object({ auth: z.object({ user: z.string() }) }),
      'auth',
      'object',
    ],
    ['a nullable', z.object({ note: z.string().nullable() }), 'note', ''],
    ['a number enum', z.object({ level: z.literal([1, 2]) }), 'level', ''],
  ])('refuses %s, naming the setting', (_, schema, key, type) => {
    const form = settingsFormOf(settingsJsonSchema(schema))
    expect(form.ok).toBe(false)
    if (form.ok) return
    expect(form.reason).toContain(`setting ${key} is`)
    expect(form.reason).toContain(type)
    expect(form.reason).toContain(
      'the form renders string, number, boolean and enum settings only',
    )
  })

  it('refuses a keyword it does not check, rather than accepting what the plugin would refuse', () => {
    const form = settingsFormOf({
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
    })
    expect(form.ok).toBe(false)
  })

  it('refuses a settings block that is not an object schema', () => {
    expect(settingsFormOf({ type: 'string' }).ok).toBe(false)
    expect(settingsFormOf('nope').ok).toBe(false)
  })
})

describe('formValuesOf', () => {
  it('starts from the stored config, then the declared default', () => {
    const fields = fieldsOf(apollo)
    expect(formValuesOf(fields, { cacheDays: 30, feeds: ['x'] })).toEqual({
      cacheDays: '30',
      dailyCreditCap: '100',
      autoEnrich: false,
    })
  })
})

describe('checkSettings', () => {
  const fields = fieldsOf(apollo)
  const good = { cacheDays: '30', dailyCreditCap: '100', autoEnrich: true }

  it('passes values that meet the schema, typed', () => {
    expect(checkSettings(fields, good)).toEqual({
      ok: true,
      values: { cacheDays: 30, dailyCreditCap: 100, autoEnrich: true },
    })
  })

  it('returns each failing field by key, and no values', () => {
    expect(
      checkSettings(fields, {
        ...good,
        cacheDays: '5000',
        dailyCreditCap: 'lots',
      }),
    ).toEqual({
      ok: false,
      errors: {
        cacheDays: 'must be between 0 and 3650',
        dailyCreditCap: 'must be a number',
      },
    })
    expect(checkSettings(fields, { ...good, cacheDays: '1.5' })).toEqual({
      ok: false,
      errors: { cacheDays: 'must be a whole number' },
    })
  })

  it('drops an emptied optional field so the default applies, and refuses an emptied required one', () => {
    expect(checkSettings(fields, { ...good, cacheDays: '' })).toMatchObject({
      ok: true,
      values: { cacheDays: undefined },
    })
    const required = fieldsOf(
      settingsJsonSchema(z.object({ label: z.string(), tier: z.enum(['a']) })),
    )
    expect(checkSettings(required, { label: '', tier: '' })).toEqual({
      ok: false,
      errors: { label: 'required', tier: 'required' },
    })
    expect(checkSettings(required, { label: 'x', tier: 'b' })).toEqual({
      ok: false,
      errors: { tier: 'must be one of a' },
    })
  })

  it('checks string length, pattern and format', () => {
    const strings = fieldsOf(
      settingsJsonSchema(
        z.object({
          code: z
            .string()
            .min(2)
            .max(4)
            .regex(/^[A-Z]+$/),
          contact: z.email().optional(),
          endpoint: z.url().optional(),
        }),
      ),
    )
    expect(
      checkSettings(strings, { code: 'a', contact: 'nope', endpoint: 'nope' }),
    ).toEqual({
      ok: false,
      errors: {
        code: 'must be at least 2 characters',
        contact: 'must be an email address',
        endpoint: 'must be a URL',
      },
    })
    expect(checkSettings(strings, { code: 'abc' })).toMatchObject({
      ok: false,
      errors: { code: 'must match ^[A-Z]+$' },
    })
  })
})

describe('mergeConfig', () => {
  it('keeps keys the form does not draw and drops emptied ones', () => {
    expect(
      mergeConfig(
        { cacheDays: 90, feeds: ['https://example.com/feed'] },
        { cacheDays: undefined, autoEnrich: true },
      ),
    ).toEqual({ feeds: ['https://example.com/feed'], autoEnrich: true })
  })
})

describe('labelOf', () => {
  it('turns a key into a sentence-case label', () => {
    expect(labelOf('dailyCreditCap')).toBe('Daily credit cap')
    expect(labelOf('feed_url')).toBe('Feed url')
  })
})
