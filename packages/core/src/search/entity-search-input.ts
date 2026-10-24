import { z } from 'zod'

/**
 * Input for entity autocomplete (`searchEntities`: mentions, reference
 * pickers). Must not import `db`: a server fn's `.validator()` ships to the
 * client bundle. The query that takes it is `entitySearchRows`.
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
