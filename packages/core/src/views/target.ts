import { Schema } from 'effect'
import type { ViewSurface } from '@spaces/db/schema/views'
import { uuidString } from '../attributes/registry'

export type { ViewSurface }

/**
 * How a view names the list it belongs to: the key half of the view server
 * fns, and the `view_surface_object_id` CHECK spelled as a type. `object` is a
 * row of the object registry; `document` is /documents, which has no object
 * row or attribute registry, so it takes no further fields.
 * - A third surface is a `view_surface` enum migration plus an arm here and
 *   wherever this union is matched — never a registry row.
 * - Client-safe: the ViewBar builds a target, and the view store imports db.
 */
export type ViewTarget =
  { surface: 'object'; objectId: string } | { surface: 'document' }

/**
 * The target a page's ViewBar saves against. A page holds an object id when
 * its list is an object's records and null when it is not — the same
 * equivalence the CHECK asserts, so the mapping is total in both directions.
 */
export const viewTarget = (objectId: string | null): ViewTarget =>
  objectId === null ? { surface: 'document' } : { surface: 'object', objectId }

/**
 * The unresolved key a caller sends. On the `object` surface it names the
 * object either by core kind or by id — **exactly one**, so a call that
 * supplies neither is a validation error rather than a silent resolve to
 * 'company'.
 */
export const objectKeyFields = {
  surface: Schema.Literal('object'),
  kind: Schema.optional(Schema.Literals(['company', 'person', 'deal'])),
  objectId: Schema.optional(uuidString),
}

export const documentKeyFields = { surface: Schema.Literal('document') }

export const exactlyOneObjectRef = (v: {
  readonly kind?: string | undefined
  readonly objectId?: string | undefined
}) => (v.kind === undefined) !== (v.objectId === undefined)

export const exactlyOneObjectRefMessage = {
  message: 'Give exactly one of kind or objectId',
}

/** The check every object-surface key takes beside `objectKeyFields`. */
export const oneObjectRef = Schema.makeFilter(
  (v: Parameters<typeof exactlyOneObjectRef>[0]) =>
    exactlyOneObjectRef(v) || exactlyOneObjectRefMessage.message,
)

export const surfaceKey = Schema.Union([
  Schema.Struct(objectKeyFields).check(oneObjectRef),
  Schema.Struct(documentKeyFields),
])

export type SurfaceKey = typeof surfaceKey.Type
