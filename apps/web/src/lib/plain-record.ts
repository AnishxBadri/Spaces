import { Schema, SchemaTransformation } from 'effect'

/**
 * A string-keyed record of plain objects only. `Schema.Record` alone takes a
 * date, a map or a class instance as an empty record and keeps a
 * `__proto__` key; this refuses the first three and drops the key, so a
 * record input reads as one a JSON body could have sent. Client-safe: server
 * fn validators use it and ship to the browser.
 */

/** `Object.prototype` or no prototype, never a class instance, and no symbol key. */
const isPlainObject = (u: unknown): u is { readonly [k: string]: unknown } => {
  if (typeof u !== 'object' || u === null || Array.isArray(u)) return false
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

const plainObject = Schema.declare(isPlainObject, {
  expected: 'a plain object',
}).pipe(
  Schema.decode(
    SchemaTransformation.transform({
      decode: (o: { readonly [k: string]: unknown }) =>
        Object.fromEntries(
          Object.entries(o).filter(([k]) => k !== '__proto__'),
        ),
      encode: (o: { readonly [k: string]: unknown }) => o,
    }),
  ),
)

/** A record whose every value decodes through `value`. */
export const plainRecord = <TValue extends Schema.Top>(value: TValue) =>
  plainObject.pipe(
    Schema.decodeTo(
      Schema.Record(Schema.String, value),
      SchemaTransformation.passthroughSupertype(),
    ),
  )
