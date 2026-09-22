import { z } from 'zod'
import type { ViewSurface } from '@spaces/db/schema/views'

export type { ViewSurface }

/**
 * How a view names the list it belongs to (D2, decided 2026-09-23) — the
 * key half of the view server fns, and the `view_surface_object_id` CHECK
 * spelled as a type. `object` is a row of the object registry; `document` is
 * /documents, a research kind with no object row and no attribute registry,
 * so it takes no further fields.
 *
 * A third surface is a migration to the `view_surface` enum plus an arm
 * here and a branch wherever this union is matched — never a registry row.
 * See CONTEXT.md "Lists — deferred" for the rule that admits one.
 *
 * Client-safe on purpose: the ViewBar builds a target to save with, and
 * `views/store.ts` cannot be imported from the browser (it imports the db).
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
 * 'company' (which is what this slice removed).
 */
export const objectKeyFields = {
  surface: z.literal('object'),
  kind: z.enum(['company', 'person', 'deal']).optional(),
  objectId: z.string().uuid().optional(),
}

export const documentKeyFields = { surface: z.literal('document') }

export const exactlyOneObjectRef = (v: {
  kind?: string | undefined
  objectId?: string | undefined
}) => (v.kind === undefined) !== (v.objectId === undefined)

export const exactlyOneObjectRefMessage = {
  message: 'Give exactly one of kind or objectId',
}

export const surfaceKey = z.discriminatedUnion('surface', [
  z
    .object(objectKeyFields)
    .refine(exactlyOneObjectRef, exactlyOneObjectRefMessage),
  z.object(documentKeyFields),
])

export type SurfaceKey = z.infer<typeof surfaceKey>
