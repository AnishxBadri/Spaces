import {
  Effect,
  Predicate,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from 'effect'
import type { StandardSchemaV1 } from 'effect/StandardSchema'
import { finite, int, uuidString } from '@spaces/core/attributes/registry'
import { jsonValue } from '@spaces/core/json'
import type { Json } from '@spaces/core/json'

/**
 * The shapes a job's data and a plugin job's answers decode through, and the
 * one decode every payload takes at the job's entry.
 */

/**
 * A job's payload schema. An Effect schema, or a Standard Schema for the
 * payloads core still declares in zod: the worker decodes those as they are
 * rather than keeping a second copy of a shape core owns.
 */
export type JobSchema<T> = Schema.Decoder<T> | StandardSchemaV1<unknown, T>

const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1()

type Issue = {
  readonly message: string
  readonly path?:
    ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

/** `documentId: Invalid UUID; userId: Missing key` — a root issue says `(root)`. */
const describe = (issues: ReadonlyArray<Issue>): string =>
  issues
    .map(({ message, path }) => {
      const field = (path ?? [])
        .map((s) => String(Predicate.isObject(s) ? s.key : s))
        .join('.')
      return `${field === '' ? '(root)' : field}: ${message}`
    })
    .join('; ')

const isStandard = <T>(
  schema: JobSchema<T>,
): schema is StandardSchemaV1<unknown, T> => !Schema.isSchema(schema)

/**
 * `data` decoded by `schema`, or every refusal in one line. Synchronous: a
 * payload schema reads no service and awaits nothing, so one that answers
 * with a promise is refused rather than awaited.
 */
export const decodeJobData = <T>(
  schema: JobSchema<T>,
  data: unknown,
): Result.Result<T, string> => {
  if (isStandard(schema)) {
    const out = schema['~standard'].validate(data)
    if (out instanceof Promise)
      return Result.fail('(root): the schema decodes asynchronously')
    return out.issues === undefined
      ? Result.succeed(out.value)
      : Result.fail(describe(out.issues))
  }
  const decoded = SchemaParser.decodeUnknownResult(schema, { errors: 'all' })(
    data,
  )
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(describe(standardIssues(decoded.failure).issues))
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** An RFC 9562 UUID, or the nil and max ones. */
export const uuid = uuidString

/** A string with at least one character; whitespace counts. */
export const nonEmpty = Schema.String.check(Schema.isMinLength(1))

/** A string `new URL` parses once trimmed, handed on trimmed. Any scheme. */
export const urlString = Schema.String.pipe(
  Schema.decode(
    SchemaTransformation.transformOrFail({
      decode: (raw: string) =>
        URL.canParse(raw.trim())
          ? Effect.succeed(raw.trim())
          : Effect.fail(
              new SchemaIssue.InvalidValue({ message: 'Invalid URL' }),
            ),
      encode: (href: string) => Effect.succeed(href),
    }),
  ),
)

/** A whole number from zero, inside the safe integers. */
export const nonNegativeInt = Schema.Number.check(
  finite,
  int,
  Schema.isGreaterThanOrEqualTo(0),
)

/** A finite number from zero. */
export const nonNegative = Schema.Number.check(
  finite,
  Schema.isGreaterThanOrEqualTo(0),
)

const isJsonObject = (value: Json): value is { [k: string]: Json } =>
  Predicate.isObject(value)

/**
 * A plain object of JSON values, copied: never a list, a date, a map or a
 * class instance, and a `__proto__` key is dropped rather than copied.
 */
export const jsonObject = jsonValue.pipe(
  Schema.refine(isJsonObject, { message: 'Expected an object of JSON values' }),
)

/**
 * An object whose keys the job ignores, handed on as `{}`. Not
 * `Schema.Struct({})`, which accepts any value but null and undefined and
 * keeps every key.
 */
export const emptyObject = Schema.declare(Predicate.isObject, {
  expected: 'object',
}).pipe(
  Schema.decodeTo(
    Schema.Struct({}),
    SchemaTransformation.transform({
      decode: () => ({}),
      encode: () => ({}),
    }),
  ),
)

/**
 * A scheduled job's data: pg-boss stores `null` for a schedule registered
 * with no payload, which reads as `none`.
 */
export const scheduled = <TStruct extends Schema.Top>(
  struct: TStruct,
  none: TStruct['Type'],
) =>
  Schema.NullishOr(struct).pipe(
    Schema.decodeTo(
      Schema.toType(struct),
      SchemaTransformation.transform({
        decode: (value: TStruct['Type'] | null | undefined): TStruct['Type'] =>
          value ?? none,
        encode: (value: TStruct['Type']) => value,
      }),
    ),
  )
