import { Effect, Schema } from 'effect'

/**
 * A route's search, decoded by an Effect schema. Client-safe: the router
 * validates the search in the browser and on the server, so both decode the
 * same URL to the same value.
 */

/**
 * A route's `validateSearch`. The router runs its Standard Schema `validate`
 * and throws a refusal as a SearchParamError; a link's `search` is typed by
 * the schema's encoded side and `useSearch()` by its decoded side. `parse`
 * decodes the same way outside a router and throws a refusal.
 */
export function searchValidator<
  TSchema extends Schema.ConstraintDecoder<unknown>,
>(schema: TSchema) {
  return {
    '~standard': Schema.toStandardSchemaV1(schema)['~standard'],
    parse: Schema.decodeUnknownSync(schema),
  }
}

/**
 * An optional key whose bad value reads as `undefined`, so a hand-typed
 * `?tab=nonsense` lands on the page rather than an error boundary. A key
 * never sent stays absent; one sent stays present, as `undefined` when bad.
 */
export const caught = <TSchema extends Schema.Top>(schema: TSchema) =>
  Schema.optionalKey(
    Schema.UndefinedOr(schema).pipe(
      Schema.catchDecoding(() => Effect.succeedSome(undefined)),
    ),
  )

/**
 * A key that reads as `value` when it is missing, `undefined` or bad. The
 * catch wraps the default: the default's encoded side is the bare literal,
 * so a bad value fails there, outside a catch on the inner schema.
 */
export const fallback = <TSchema extends Schema.Top>(
  schema: TSchema,
  value: TSchema['Type'] & TSchema['Encoded'],
) =>
  schema.pipe(
    Schema.withDecodingDefault(Effect.succeed(value)),
    Schema.catchDecoding(() => Effect.succeedSome(value)),
  )
