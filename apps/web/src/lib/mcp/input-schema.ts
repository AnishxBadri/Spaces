import { Result, SchemaIssue, SchemaParser } from 'effect'
import type { Schema } from 'effect'
import { jsonSchema } from 'ai'
import type { JSONSchema7 } from 'ai'

/** A subschema: a schema, or `true` / `false` for anything / nothing. */
type JSONSchema7Definition = NonNullable<JSONSchema7['additionalProperties']>

/**
 * A tool's input as a client is shown it: JSON Schema draft-07, written as
 * data beside the Effect schema that decodes the call. The two say the same
 * thing: the tool table's characterisation test holds both to what clients
 * were shown and accepted before, and their fields to each other.
 */
export type ToolInputSchema = {
  $schema: typeof DRAFT_07
  type: 'object'
  properties: { [field: string]: JSONSchema7 }
  required?: Array<string>
  definitions?: { [name: string]: JSONSchema7 }
}

export const DRAFT_07 = 'http://json-schema.org/draft-07/schema#'

/** RFC 9562, the nil and the max UUID, as `uuidString` decodes them. */
export const UUID_PATTERN =
  '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

const closedAll = (
  schemas: { [k: string]: JSONSchema7Definition } | undefined,
) =>
  schemas === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(schemas).map(([k, s]) => [k, closedDefinition(s)]),
      )

const closedDefinition = (s: JSONSchema7Definition): JSONSchema7Definition =>
  typeof s === 'boolean' ? s : closedObjects(s)

/**
 * The input as a language model is shown it: every object that names its
 * properties and says nothing of others refuses others, which is how the AI
 * SDK spells a struct for the model. Decoding still only drops a stray key.
 */
export function closedObjects(schema: JSONSchema7): JSONSchema7 {
  const properties = closedAll(schema.properties)
  const definitions = closedAll(schema.definitions)
  const { additionalProperties, items, anyOf } = schema
  return {
    ...schema,
    ...(properties === undefined ? {} : { properties }),
    ...(definitions === undefined ? {} : { definitions }),
    ...(anyOf === undefined ? {} : { anyOf: anyOf.map(closedDefinition) }),
    ...(items === undefined
      ? {}
      : {
          items: Array.isArray(items)
            ? items.map(closedDefinition)
            : closedDefinition(items),
        }),
    ...(additionalProperties === undefined
      ? properties === undefined
        ? {}
        : { additionalProperties: false }
      : { additionalProperties: closedDefinition(additionalProperties) }),
  }
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

// `budget: Expected …; refs[0]: Expected a string`; a root issue stands alone.
const describeIssue = (issue: SchemaIssue.Issue) =>
  formatIssues(issue)
    .issues.map(({ message, path }) => {
      const field = (path ?? [])
        .map((s) => {
          const key = typeof s === 'object' ? s.key : s
          return typeof key === 'number'
            ? `[${String(key)}]`
            : `.${String(key)}`
        })
        .join('')
        .replace(/^\./, '')
      return field === '' ? message : `${field}: ${message}`
    })
    .join('; ')

/** A tool input's decode: the input as the tool reads it, or every refusal in one sentence. */
export const decoderFor = <T>(decoder: Schema.Decoder<T>) => {
  const decode = SchemaParser.decodeUnknownResult(decoder, { errors: 'all' })
  return (raw: unknown): Result.Result<T, string> =>
    Result.mapError(decode(raw), describeIssue)
}

/**
 * A tool input for the AI SDK: `shown` is what the model reads, and the
 * decode checks its call before `execute` runs, so a refused call never
 * reaches the tool.
 */
export const modelSchema = <T>(
  shown: JSONSchema7,
  decode: (raw: unknown) => Result.Result<T, string>,
) =>
  jsonSchema<T>(shown, {
    validate: (value) => {
      const decoded = decode(value)
      return Result.isSuccess(decoded)
        ? { success: true, value: decoded.success }
        : { success: false, error: new Error(decoded.failure) }
    },
  })
