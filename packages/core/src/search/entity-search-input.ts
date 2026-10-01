import { z } from 'zod'

/**
 * The autocomplete's input (`searchEntities`, mentions and reference
 * pickers). Pure on purpose (SPA-198): `apps/web/src/lib/server/search.ts`
 * hands it to a server fn's `.validator()`, which survives into the client
 * bundle, so this module must not reach `db`. The query that takes it is
 * `@spaces/core/writes/read/entity-search`.
 */
export const entitySearchInput = z.object({
  q: z.string().max(120),
  kinds: z
    .array(
      z.enum([
        'company',
        'person',
        'deal',
        'space',
        'note',
        'document',
        'custom',
      ]),
    )
    .optional(),
  /** narrow to one object's records — a custom-object reference picker */
  objectId: z.string().uuid().optional(),
})

export type EntitySearchInput = z.infer<typeof entitySearchInput>
