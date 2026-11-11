import { Predicate, Result, Schema, SchemaIssue, SchemaParser } from 'effect'

/** A server fn's input failed its schema; `message` names each field. */
class InputRefused extends Schema.TaggedError<InputRefused>()('InputRefused', {
  message: Schema.String,
}) {}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const segment = (s: PropertyKey | { readonly key: PropertyKey }) => {
  const key = Predicate.isObject(s) ? s.key : s
  return typeof key === 'number' ? `[${key}]` : `.${String(key)}`
}

// `content: Expected …; entityIds[0]: Expected a UUID`. A root issue has no
// path and stands alone.
const describe = (issue: SchemaIssue.Issue) =>
  formatIssues(issue)
    .issues.map(({ message, path }) => {
      const field = (path ?? []).map(segment).join('').replace(/^\./, '')
      return field === '' ? message : `${field}: ${message}`
    })
    .join('; ')

/**
 * The `.validator()` of a server fn, from an Effect schema. The caller's
 * `data` is the schema's encoded side and the handler's `data` its decoded
 * side, so a trim or a default has already happened inside the handler.
 * A refused input rejects the call with an error whose `message` lists each
 * failing field and what it expected, every failure at once.
 *
 * A validator, not a Standard Schema: TanStack serializes a Standard
 * Schema's issues to JSON as the message, and a throw is how a validator
 * sets its own.
 */
export const input = <TSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: TSchema,
) => {
  const decode = SchemaParser.decodeUnknownResult(schema, { errors: 'all' })
  return (value: TSchema['Encoded']): TSchema['Type'] => {
    const decoded = decode(value)
    if (Result.isFailure(decoded))
      throw new InputRefused({ message: describe(decoded.failure) })
    return decoded.success
  }
}
