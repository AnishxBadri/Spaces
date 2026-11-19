import {
  Effect,
  Result,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from 'effect'
import { emailString, uuidString } from '../attributes/registry'

/**
 * The Effect schemas the AI layer reads a model's answer and a suggestion's
 * payload through, with the reading rules those inputs have always had:
 * - Every check on a field runs and reports, not only the first, and a
 *   length check still reads an array or a string where another type was
 *   wanted; `readPayload` hands the propose path every issue, in order.
 * - An object is any non-null, non-array object, its fields read as
 *   properties (inherited ones included); a strict object names every
 *   unrecognised key after its fields' issues, and `__proto__` is never a
 *   key.
 * - A refusal is worded the same way everywhere ("Invalid input: expected
 *   string, received number"), because the review queue prints it.
 */

/** The runtime type a refusal says it received: `NaN` apart from `number`, a class by its name. */
function receivedOf(u: unknown): string {
  if (typeof u === 'number') return Number.isNaN(u) ? 'NaN' : 'number'
  if (typeof u === 'object') {
    if (u === null) return 'null'
    if (Array.isArray(u)) return 'array'
    const ctor: unknown = Reflect.get(u, 'constructor')
    if (Object.getPrototypeOf(u) !== Object.prototype && ctor)
      return String(Reflect.get(Object(ctor), 'name'))
  }
  return typeof u
}

const typeWords = (expected: string, input: unknown): string =>
  `Invalid input: expected ${expected}, received ${receivedOf(input)}`

/**
 * The annotation that marks a refusal as leaving the value readable — a
 * length, format or rule check — after which an object's own rule still
 * runs. A wrong type, an unknown option or an unrecognised key stops it.
 */
const CONTINUES = 'aiReadContinues'

const refusal = (message: string, input: unknown, continues = false) =>
  new SchemaIssue.InvalidValue(
    continues ? { message, [CONTINUES]: true } : { message },
    input,
  )

/** A check that refuses with the words it returns and lets later checks read on. */
const rule = <T>(words: (input: T) => string | undefined) =>
  Schema.makeFilter((input: T) => words(input), { [CONTINUES]: true })

const typeCheck = (expected: string, is: (u: unknown) => boolean) =>
  Schema.makeFilter((u: unknown) => is(u) || typeWords(expected, u))

/** What a length check reads: anything with a `length`, not only the type it wanted. */
function lengthOf(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const length: unknown = Reflect.get(Object(v), 'length')
  return length === undefined ? null : Number(length)
}

function sizeWords(
  v: unknown,
  bound: number,
  side: 'min' | 'max',
): string | undefined {
  const length = lengthOf(v)
  if (length === null) return undefined
  if (side === 'min' ? length >= bound : length <= bound) return undefined
  const [lead, op] = side === 'min' ? ['Too small', '>='] : ['Too big', '<=']
  if (typeof v === 'string')
    return `${lead}: expected string to have ${op}${bound} characters`
  if (Array.isArray(v))
    return `${lead}: expected array to have ${op}${bound} items`
  return `${lead}: expected unknown to be ${op}${bound}`
}

const isEmail = Schema.is(emailString)
const isUuid = Schema.is(uuidString)

export type TextFormat =
  | 'email'
  | 'uuid'
  | 'url'
  | { readonly pattern: RegExp; readonly message: string }

/**
 * A string. The steps run in this order — trim, the format, the minimum
 * and the maximum length — each seeing what the step before left: a
 * trimmed string, and a URL trimmed once it parses.
 */
export function text(
  steps: {
    readonly trim?: boolean
    readonly format?: TextFormat
    readonly min?: number
    readonly max?: number
  } = {},
): Schema.Decoder<string> {
  const { trim = false, format, min, max } = steps
  const trimmed = (u: unknown): unknown =>
    trim && typeof u === 'string' ? u.trim() : u
  const formatted = (u: unknown): unknown => {
    const v = trimmed(u)
    return format === 'url' && typeof v === 'string' && URL.canParse(v.trim())
      ? v.trim()
      : v
  }
  const formatWords = (v: string): string | undefined => {
    if (format === undefined) return undefined
    if (format === 'email')
      return isEmail(v) ? undefined : 'Invalid email address'
    if (format === 'uuid') return isUuid(v) ? undefined : 'Invalid UUID'
    if (format === 'url')
      return URL.canParse(v.trim()) ? undefined : 'Invalid URL'
    return format.pattern.test(v) ? undefined : format.message
  }
  return Schema.Unknown.check(
    typeCheck('string', (u) => typeof u === 'string'),
    rule((u: unknown) => {
      const v = trimmed(u)
      return typeof v === 'string' ? formatWords(v) : undefined
    }),
    rule((u: unknown) =>
      min === undefined ? undefined : sizeWords(formatted(u), min, 'min'),
    ),
    rule((u: unknown) =>
      max === undefined ? undefined : sizeWords(formatted(u), max, 'max'),
    ),
  ).pipe(
    Schema.decodeTo(Schema.String, SchemaTransformation.passthroughSupertype()),
    Schema.decode(
      SchemaTransformation.transform({
        decode: (s: string) => {
          const v = formatted(s)
          return typeof v === 'string' ? v : s
        },
        encode: (s: string) => s,
      }),
    ),
  )
}

const isFiniteNumber = (u: unknown): u is number =>
  typeof u === 'number' && Number.isFinite(u)

/** A finite number, optionally bounded; NaN and the infinities are refused as types. */
export function number(
  bounds: { readonly min?: number; readonly max?: number } = {},
): Schema.Decoder<number> {
  const { min, max } = bounds
  return Schema.Unknown.check(
    typeCheck('number', isFiniteNumber),
    rule((u: unknown) =>
      min !== undefined && isFiniteNumber(u) && u < min
        ? `Too small: expected number to be >=${min}`
        : undefined,
    ),
    rule((u: unknown) =>
      max !== undefined && isFiniteNumber(u) && u > max
        ? `Too big: expected number to be <=${max}`
        : undefined,
    ),
  ).pipe(
    Schema.decodeTo(Schema.Number, SchemaTransformation.passthroughSupertype()),
  )
}

/** One of `values`, refused in the same words whatever else arrives. */
export function oneOf<const TValues extends ReadonlyArray<string>>(
  values: TValues,
): Schema.Decoder<TValues[number]> {
  const words = `Invalid option: expected one of ${values.map((v) => JSON.stringify(v)).join('|')}`
  return Schema.Unknown.check(
    Schema.makeFilter((u: unknown) => values.some((v) => v === u) || words),
  ).pipe(
    Schema.decodeTo(
      Schema.Literals(values),
      SchemaTransformation.passthroughSupertype(),
    ),
  )
}

/** `schema` held to `holds`, refused with `words`; checked only once `schema` decodes. */
export function holding<T>(
  schema: Schema.Decoder<T>,
  holds: (value: T) => boolean,
  words: string,
): Schema.Decoder<T> {
  return schema.check(rule((value: T) => (holds(value) ? undefined : words)))
}

/** Parse options with the input kept, so a type refusal can name what it got. */
const withInput = (
  options: SchemaAST.ParseOptions,
): SchemaAST.ParseOptions => ({ ...options, reportInput: true })

const failWith = (
  issues: ReadonlyArray<SchemaIssue.Issue>,
  input: unknown,
): Effect.Effect<never, SchemaIssue.Issue> => {
  const first = issues.at(0)
  if (first === undefined) return Effect.fail(refusal('Invalid input', input))
  return Effect.fail(
    issues.length === 1
      ? first
      : new SchemaIssue.Composite(
          Schema.Unknown.ast,
          [first, ...issues.slice(1)],
          input,
        ),
  )
}

/**
 * A list. Each item's issues come first; the maximum length is checked
 * after them, on any input with a length. An absent list reads as
 * `fallback()` when one is given.
 */
export function list<T>(
  item: Schema.Decoder<T>,
  bounds: {
    readonly max?: number
    readonly fallback?: () => Array<T>
  } = {},
): Schema.Decoder<Array<T>> {
  const { max, fallback } = bounds
  const items = Schema.mutable(Schema.Array(item))
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.mutable(Schema.Array(Schema.toType(item))),
      SchemaTransformation.transformOrFail({
        decode: (u: unknown, parse) => {
          if (u === undefined && fallback) return Effect.succeed(fallback())
          const issues: Array<SchemaIssue.Issue> = []
          let decoded: Array<T> = []
          if (Array.isArray(u)) {
            const r = SchemaParser.decodeUnknownResult(
              items,
              withInput(parse),
            )(u)
            if (Result.isFailure(r)) issues.push(r.failure)
            else decoded = r.success
          } else issues.push(refusal(typeWords('array', u), u))
          if (issues.length > 0 && parse.errors !== 'all')
            return failWith(issues, u)
          const tooLong =
            max === undefined ? undefined : sizeWords(u, max, 'max')
          if (tooLong !== undefined) issues.push(refusal(tooLong, u, true))
          return issues.length > 0
            ? failWith(issues, u)
            : Effect.succeed(decoded)
        },
        encode: (a: Array<T>) => Effect.succeed(a),
      }),
    ),
  )
}

/** `inner`, or null. */
export function nullable<T>(
  inner: Schema.Decoder<T>,
): Schema.Decoder<T | null> {
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.NullOr(Schema.toType(inner)),
      SchemaTransformation.transformOrFail({
        decode: (u: unknown, parse) => {
          if (u === null) return Effect.succeed(null)
          const r = SchemaParser.decodeUnknownResult(inner, withInput(parse))(u)
          return Result.isSuccess(r)
            ? Effect.succeed(r.success)
            : Effect.fail(r.failure)
        },
        encode: (v: T | null) => Effect.succeed(v),
      }),
    ),
  )
}

/** Whether `issue` holds only refusals that leave the value readable. */
function onlyContinues(issue: SchemaIssue.Issue): boolean {
  switch (issue._tag) {
    case 'Pointer':
    case 'Encoding':
      return onlyContinues(issue.issue)
    case 'Composite':
    case 'AnyOf':
      return issue.issues.every(onlyContinues)
    case 'Filter':
      return (
        issue.filter.annotations?.[CONTINUES] === true ||
        onlyContinues(issue.issue)
      )
    case 'InvalidValue':
      return issue.annotations?.[CONTINUES] === true
    default:
      return false
  }
}

const isObjectLike = (u: unknown): u is object =>
  typeof u === 'object' && u !== null && !Array.isArray(u)

const unrecognised = (keys: ReadonlyArray<string>): string =>
  `Unrecognized key${keys.length === 1 ? '' : 's'}: ${keys.map((k) => JSON.stringify(k)).join(', ')}`

/**
 * An object of `fields`, read as properties of any non-null, non-array
 * object. `Schema.optional` marks a field that may be absent or undefined;
 * every other field is read even when absent, so a missing string is
 * refused as "received undefined". The decoded object is a fresh plain one
 * holding the fields that were there.
 * - `strict` refuses unrecognised keys, inherited ones too, named together
 *   after the fields' issues.
 * - `rule` reads the fields as given, and runs while every refusal before
 *   it leaves them readable: after a length check, never after a type.
 */
export function object<
  const TFields extends { readonly [k: string]: Schema.Decoder<unknown> },
>(
  fields: TFields,
  options: {
    readonly strict?: boolean
    readonly rule?: {
      readonly holds: (given: { readonly [k: string]: unknown }) => boolean
      readonly words: string
    }
  } = {},
): Schema.Decoder<Schema.Struct.Type<TFields>> {
  const keys = Object.keys(fields)
  const { strict = false, rule: whole } = options
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transformOrFail({
        decode: (u: unknown, parse) => {
          if (!isObjectLike(u))
            return failWith([refusal(typeWords('object', u), u)], u)
          const all = parse.errors === 'all'
          const issues: Array<SchemaIssue.Issue> = []
          const given: { [k: string]: unknown } = {}
          const out: { [k: string]: unknown } = {}
          for (const [key, field] of Object.entries(fields)) {
            const present = key in u
            const raw: unknown = Reflect.get(u, key)
            given[key] = raw
            if (SchemaAST.isOptional(field.ast) && raw === undefined) {
              if (present) out[key] = undefined
              continue
            }
            const r = SchemaParser.decodeUnknownResult(
              field,
              withInput(parse),
            )(raw)
            if (Result.isFailure(r)) {
              issues.push(new SchemaIssue.Pointer([key], r.failure))
              if (!all) return failWith(issues, u)
              continue
            }
            if (r.success === undefined && !present) {
              // A field that takes anything still has to be there.
              issues.push(
                new SchemaIssue.Pointer(
                  [key],
                  refusal(typeWords('nonoptional', undefined), undefined),
                ),
              )
              if (!all) return failWith(issues, u)
              continue
            }
            out[key] = r.success
          }
          if (strict) {
            const extra: Array<string> = []
            for (const key in u)
              if (key !== '__proto__' && !keys.includes(key)) extra.push(key)
            if (extra.length > 0) {
              issues.push(refusal(unrecognised(extra), u))
              if (!all) return failWith(issues, u)
            }
          }
          if (whole && issues.every(onlyContinues) && !whole.holds(given))
            issues.push(refusal(whole.words, u, true))
          return issues.length > 0 ? failWith(issues, u) : Effect.succeed(out)
        },
        encode: (v: unknown) => Effect.succeed(v),
      }),
    ),
    // The fields decoded above; the type side checks the object built.
    Schema.decodeTo(
      Schema.toType(Schema.Struct(fields)),
      SchemaTransformation.passthrough({ strict: false }),
    ),
  )
}

/**
 * One of several objects, picked by the string at `key`. A value at `key`
 * that names none of them is refused there, before any field is read.
 */
export function tagged<
  const TMembers extends { readonly [tag: string]: Schema.Decoder<unknown> },
>(
  key: string,
  members: TMembers,
): Schema.Decoder<TMembers[keyof TMembers]['Type']> {
  const tags = Object.keys(members)
  const words = `Invalid discriminator value. Expected ${tags.map((t) => `'${t}'`).join(' | ')}`
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.Union(Object.values(members).map((m) => Schema.toType(m))),
      SchemaTransformation.transformOrFail({
        decode: (u: unknown, parse) => {
          if (!isObjectLike(u))
            return failWith([refusal(typeWords('object', u), u)], u)
          const tag: unknown = Reflect.get(u, key)
          const member =
            typeof tag === 'string' && Object.hasOwn(members, tag)
              ? members[tag]
              : undefined
          if (member === undefined)
            return failWith(
              [new SchemaIssue.Pointer([key], refusal(words, tag))],
              u,
            )
          const r = SchemaParser.decodeUnknownResult(
            member,
            withInput(parse),
          )(u)
          return Result.isSuccess(r)
            ? Effect.succeed(r.success)
            : Effect.fail(r.failure)
        },
        encode: (v: TMembers[keyof TMembers]['Type']) => Effect.succeed(v),
      }),
    ),
  )
}

/** `Object.prototype` or no prototype, never a class instance, and no enumerable symbol key. */
function isPlainObject(u: unknown): u is { readonly [k: string]: unknown } {
  if (!isObjectLike(u)) return false
  if (
    Object.getOwnPropertySymbols(u).some((k) =>
      Object.prototype.propertyIsEnumerable.call(u, k),
    )
  )
    return false
  const ctor: unknown = Reflect.get(u, 'constructor')
  if (typeof ctor !== 'function') return true
  const prototype: unknown = Reflect.get(ctor, 'prototype')
  return (
    typeof prototype === 'object' &&
    prototype !== null &&
    Object.prototype.hasOwnProperty.call(prototype, 'isPrototypeOf')
  )
}

/**
 * An answer keyed by slug: a plain object only, so a date, a map or a
 * class instance is refused rather than read as empty, and a `__proto__`
 * key is dropped rather than copied. Own enumerable keys only.
 */
export const plainRecord: Schema.Decoder<{ [k: string]: unknown }> =
  Schema.declare(isPlainObject, { expected: 'a plain object' }).pipe(
    Schema.decode(
      SchemaTransformation.transform({
        decode: (o: { readonly [k: string]: unknown }) =>
          Object.fromEntries(
            Object.entries(o).filter(([k]) => k !== '__proto__'),
          ),
        encode: (o: { readonly [k: string]: unknown }) => o,
      }),
    ),
    Schema.decodeTo(
      Schema.Record(Schema.String, Schema.mutableKey(Schema.Unknown)),
      SchemaTransformation.passthroughSupertype(),
    ),
  )

/** One refusal: where (`a.0.b`, empty for the whole) and in what words. */
export type PayloadIssue = { path: string; message: string }

export type PayloadRead<T> =
  { success: true; data: T } | { success: false; issues: Array<PayloadIssue> }

const EXPECTED: Partial<Record<SchemaAST.AST['_tag'], string>> = {
  String: 'string',
  Number: 'number',
  Boolean: 'boolean',
  Arrays: 'array',
  Objects: 'object',
}

const annotatedMessage = (
  annotations: { readonly [k: string]: unknown } | undefined,
): string | undefined => {
  const message = annotations?.message
  return typeof message === 'string' ? message : undefined
}

function leaves(
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
): Array<{ path: ReadonlyArray<PropertyKey>; message: string }> {
  switch (issue._tag) {
    case 'Pointer':
      return leaves(issue.issue, [...path, ...issue.path])
    case 'Encoding':
      return leaves(issue.issue, path)
    case 'Composite':
      return issue.issues.flatMap((i) => leaves(i, path))
    case 'AnyOf':
      return issue.issues.length > 0
        ? issue.issues.flatMap((i) => leaves(i, path))
        : [{ path, message: 'Invalid input' }]
    case 'Filter': {
      const message =
        (issue.issue._tag === 'InvalidValue'
          ? annotatedMessage(issue.issue.annotations)
          : undefined) ?? annotatedMessage(issue.filter.annotations)
      return message === undefined
        ? leaves(issue.issue, path)
        : [{ path, message }]
    }
    case 'InvalidValue':
      return [
        {
          path,
          message: annotatedMessage(issue.annotations) ?? 'Invalid input',
        },
      ]
    case 'InvalidType':
      return [
        {
          path,
          message: typeWords(
            EXPECTED[issue.ast._tag] ?? 'value',
            SchemaIssue.hasInput(issue) ? issue.input : undefined,
          ),
        },
      ]
    default:
      return [{ path, message: SchemaIssue.defaultLeafHook(issue) }]
  }
}

/**
 * `raw` decoded by `schema`, or every refusal in order with its path — what
 * the propose path refuses a payload with, field by field.
 */
export function readPayload<T>(
  schema: Schema.Decoder<T>,
  raw: unknown,
): PayloadRead<T> {
  const decoded = SchemaParser.decodeUnknownResult(schema, {
    errors: 'all',
    reportInput: true,
  })(raw)
  if (Result.isSuccess(decoded)) return { success: true, data: decoded.success }
  return {
    success: false,
    issues: leaves(decoded.failure, []).map((l) => ({
      path: l.path.map(String).join('.'),
      message: l.message,
    })),
  }
}

/** `raw` decoded by `schema`, or its first refusal's words — the one a reviewer reads. */
export function readFirst<T>(
  schema: Schema.Decoder<T>,
  raw: unknown,
): { success: true; data: T } | { success: false; message: string } {
  const read = readPayload(schema, raw)
  return read.success
    ? read
    : {
        success: false,
        message: read.issues.at(0)?.message ?? 'Invalid input',
      }
}
