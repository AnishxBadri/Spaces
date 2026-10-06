import { z } from 'zod'

/**
 * The settings form a stored manifest becomes: its `settings` JSON Schema
 * decoded into fields, the operator's input checked against them, and the
 * row's `config` merged with what passed.
 * - Four field kinds: string, number (integer or not), boolean, enum of
 *   strings. Any other property — an array, an object, a nullable, a
 *   keyword this module does not check — refuses the whole form, naming the
 *   field, so nothing is rendered badly and nothing is saved that the
 *   plugin's own schema would refuse.
 * - Pure: the route draws from it and the save path validates with it, so
 *   the form and the server agree by construction.
 */

/** What one field holds in the form: text for string, number and enum inputs. */
export type FormValue = string | boolean

/** The form's state, keyed by setting. */
export type FormValues = { [key: string]: FormValue }

type FieldBase = {
  readonly key: string
  readonly label: string
  /** The schema's `description`, shown under the label. */
  readonly hint: string | null
  /** Required with no default: an empty input is refused. */
  readonly required: boolean
}

export type StringField = FieldBase & {
  readonly kind: 'string'
  readonly default: string | null
  readonly minLength: number | null
  readonly maxLength: number | null
  readonly pattern: string | null
  readonly format: 'email' | 'uri' | null
}

export type NumberField = FieldBase & {
  readonly kind: 'number'
  readonly default: number | null
  readonly integer: boolean
  readonly minimum: number | null
  readonly maximum: number | null
  readonly exclusiveMinimum: number | null
  readonly exclusiveMaximum: number | null
}

export type BooleanField = FieldBase & {
  readonly kind: 'boolean'
  readonly default: boolean | null
}

export type EnumField = FieldBase & {
  readonly kind: 'enum'
  readonly default: string | null
  readonly options: ReadonlyArray<string>
}

export type SettingsField = StringField | NumberField | BooleanField | EnumField

export type SettingsForm =
  | { readonly ok: true; readonly fields: ReadonlyArray<SettingsField> }
  | { readonly ok: false; readonly reason: string }

/** The keywords every field kind may carry beside its own. */
const annotations = {
  title: z.string().optional(),
  description: z.string().optional(),
}

const enumProperty = z.strictObject({
  ...annotations,
  type: z.literal('string').optional(),
  enum: z.array(z.string()).min(1),
  default: z.string().optional(),
})

const stringProperty = z.strictObject({
  ...annotations,
  type: z.literal('string'),
  default: z.string().optional(),
  minLength: z.int().nonnegative().optional(),
  maxLength: z.int().nonnegative().optional(),
  pattern: z.string().optional(),
  format: z.enum(['email', 'uri']).optional(),
})

const numberProperty = z.strictObject({
  ...annotations,
  type: z.enum(['number', 'integer']),
  default: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.number().optional(),
  exclusiveMaximum: z.number().optional(),
})

const booleanProperty = z.strictObject({
  ...annotations,
  type: z.literal('boolean'),
  default: z.boolean().optional(),
})

const objectSchema = z.strictObject({
  ...annotations,
  $schema: z.string().optional(),
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  additionalProperties: z.literal(false).optional(),
})

/** `cacheDays` → `Cache days`: the label when the schema gives no title. */
export const labelOf = (key: string): string => {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** What a refused property is, for the sentence that names it. */
const describe = (property: unknown): string => {
  const parsed = z
    .object({ type: z.union([z.string(), z.array(z.string())]) })
    .safeParse(property)
  if (!parsed.success) return 'a schema the form cannot draw'
  const type = parsed.data.type
  const text = Array.isArray(type) ? type.join(' or ') : type
  return `${/^[aeiou]/.test(text) ? 'an' : 'a'} ${text}`
}

const refusal = (key: string, property: unknown): SettingsForm => ({
  ok: false,
  reason: `setting ${key} is ${describe(property)} — the form renders string, number, boolean and enum settings only`,
})

const fieldOf = (
  key: string,
  property: unknown,
  required: boolean,
): SettingsField | null => {
  const asEnum = enumProperty.safeParse(property)
  if (asEnum.success) {
    const p = asEnum.data
    return {
      kind: 'enum',
      key,
      label: p.title ?? labelOf(key),
      hint: p.description ?? null,
      required: required && p.default === undefined,
      default: p.default ?? null,
      options: p.enum,
    }
  }
  const asString = stringProperty.safeParse(property)
  if (asString.success) {
    const p = asString.data
    return {
      kind: 'string',
      key,
      label: p.title ?? labelOf(key),
      hint: p.description ?? null,
      required: required && p.default === undefined,
      default: p.default ?? null,
      minLength: p.minLength ?? null,
      maxLength: p.maxLength ?? null,
      pattern: p.pattern ?? null,
      format: p.format ?? null,
    }
  }
  const asNumber = numberProperty.safeParse(property)
  if (asNumber.success) {
    const p = asNumber.data
    return {
      kind: 'number',
      key,
      label: p.title ?? labelOf(key),
      hint: p.description ?? null,
      required: required && p.default === undefined,
      default: p.default ?? null,
      integer: p.type === 'integer',
      minimum: p.minimum ?? null,
      maximum: p.maximum ?? null,
      exclusiveMinimum: p.exclusiveMinimum ?? null,
      exclusiveMaximum: p.exclusiveMaximum ?? null,
    }
  }
  const asBoolean = booleanProperty.safeParse(property)
  if (asBoolean.success) {
    const p = asBoolean.data
    return {
      kind: 'boolean',
      key,
      label: p.title ?? labelOf(key),
      hint: p.description ?? null,
      required: false,
      default: p.default ?? null,
    }
  }
  return null
}

/**
 * A stored manifest's `settings` as form fields, in declaration order, or the
 * reason it cannot be drawn. `{}` is a plugin with no settings.
 */
export const settingsFormOf = (settings: unknown): SettingsForm => {
  const empty = z.strictObject({}).safeParse(settings)
  if (empty.success) return { ok: true, fields: [] }
  const parsed = objectSchema.safeParse(settings)
  if (!parsed.success)
    return {
      ok: false,
      reason:
        'settings is not an object schema — the form renders string, number, boolean and enum settings only',
    }
  const required = new Set(parsed.data.required ?? [])
  const fields: Array<SettingsField> = []
  for (const [key, property] of Object.entries(parsed.data.properties ?? {})) {
    const field = fieldOf(key, property, required.has(key))
    if (field === null) return refusal(key, property)
    fields.push(field)
  }
  return { ok: true, fields }
}

const formValueOf = (field: SettingsField, stored: unknown): FormValue => {
  switch (field.kind) {
    case 'boolean':
      return typeof stored === 'boolean' ? stored : (field.default ?? false)
    case 'number':
      return typeof stored === 'number'
        ? String(stored)
        : field.default === null
          ? ''
          : String(field.default)
    case 'string':
      return typeof stored === 'string' ? stored : (field.default ?? '')
    case 'enum':
      return typeof stored === 'string' && field.options.includes(stored)
        ? stored
        : (field.default ?? '')
  }
}

/** The form's starting values: the row's config, else the declared default. */
export const formValuesOf = (
  fields: ReadonlyArray<SettingsField>,
  config: { readonly [key: string]: unknown },
): FormValues =>
  Object.fromEntries(
    fields.map((f) => [
      f.key,
      formValueOf(f, Object.hasOwn(config, f.key) ? config[f.key] : undefined),
    ]),
  )

/** A setting's stored value; `undefined` drops the key so the plugin's default applies. */
type Checked =
  | { readonly ok: true; readonly value: string | number | boolean | undefined }
  | { readonly ok: false; readonly error: string }

const pass = (value: string | number | boolean | undefined): Checked => ({
  ok: true,
  value,
})
const fail = (error: string): Checked => ({ ok: false, error })

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isUri = (text: string): boolean => {
  try {
    new URL(text)
    return true
  } catch {
    return false
  }
}

const range = (field: NumberField): string | null => {
  const low = field.minimum ?? field.exclusiveMinimum
  const high = field.maximum ?? field.exclusiveMaximum
  // A bound at the safe-integer edge is zod's `int()` saying "any integer".
  const real = (n: number | null) =>
    n !== null && Math.abs(n) < Number.MAX_SAFE_INTEGER ? n : null
  const lo = real(low)
  const hi = real(high)
  if (lo !== null && hi !== null) return `must be between ${lo} and ${hi}`
  if (lo !== null) return `must be at least ${lo}`
  if (hi !== null) return `must be at most ${hi}`
  return null
}

const checkNumber = (field: NumberField, input: FormValue): Checked => {
  if (typeof input !== 'string') return fail('must be a number')
  const text = input.trim()
  if (text === '') return field.required ? fail('required') : pass(undefined)
  const n = Number(text)
  if (!Number.isFinite(n)) return fail('must be a number')
  if (field.integer && !Number.isInteger(n))
    return fail('must be a whole number')
  const outside =
    (field.minimum !== null && n < field.minimum) ||
    (field.maximum !== null && n > field.maximum) ||
    (field.exclusiveMinimum !== null && n <= field.exclusiveMinimum) ||
    (field.exclusiveMaximum !== null && n >= field.exclusiveMaximum)
  if (outside) return fail(range(field) ?? 'is out of range')
  return pass(n)
}

const checkString = (field: StringField, input: FormValue): Checked => {
  if (typeof input !== 'string') return fail('must be text')
  if (input === '') return field.required ? fail('required') : pass(undefined)
  if (field.minLength !== null && input.length < field.minLength)
    return fail(`must be at least ${field.minLength} characters`)
  if (field.maxLength !== null && input.length > field.maxLength)
    return fail(`must be at most ${field.maxLength} characters`)
  // Format first: zod emits a pattern beside it, and the format's sentence reads better.
  if (field.format === 'email' && !EMAIL.test(input))
    return fail('must be an email address')
  if (field.format === 'uri' && !isUri(input)) return fail('must be a URL')
  if (field.pattern !== null && !new RegExp(field.pattern, 'u').test(input))
    return fail(
      field.format === 'email'
        ? 'must be an email address'
        : `must match ${field.pattern}`,
    )
  return pass(input)
}

const check = (field: SettingsField, input: FormValue | undefined): Checked => {
  switch (field.kind) {
    case 'boolean':
      return typeof input === 'boolean'
        ? pass(input)
        : input === undefined
          ? pass(undefined)
          : fail('must be on or off')
    case 'number':
      return checkNumber(field, input ?? '')
    case 'string':
      return checkString(field, input ?? '')
    case 'enum': {
      const text = input ?? ''
      if (text === '')
        return field.required ? fail('required') : pass(undefined)
      return typeof text === 'string' && field.options.includes(text)
        ? pass(text)
        : fail(`must be one of ${field.options.join(', ')}`)
    }
  }
}

export type SettingsCheck =
  | {
      readonly ok: true
      /** Each field's value; `undefined` means the key comes off the config. */
      readonly values: {
        readonly [key: string]: string | number | boolean | undefined
      }
    }
  | { readonly ok: false; readonly errors: { readonly [key: string]: string } }

/** Every field checked; any error refuses the whole save. Unknown keys are ignored. */
export const checkSettings = (
  fields: ReadonlyArray<SettingsField>,
  input: FormValues,
): SettingsCheck => {
  const values: { [key: string]: string | number | boolean | undefined } = {}
  const errors: { [key: string]: string } = {}
  for (const field of fields) {
    const result = check(
      field,
      Object.hasOwn(input, field.key) ? input[field.key] : undefined,
    )
    if (result.ok) values[field.key] = result.value
    else errors[field.key] = result.error
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, values }
}

/**
 * The config to store: the row's config with each form field set or
 * dropped. Keys the form does not draw are kept — a plugin may seed config
 * the operator never edits here.
 */
export const mergeConfig = <T>(
  config: { readonly [key: string]: T },
  values: { readonly [key: string]: string | number | boolean | undefined },
): { [key: string]: T | string | number | boolean } => {
  const next: { [key: string]: T | string | number | boolean } = { ...config }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}
