import { Schema } from 'effect'
import { uuidString } from '../attributes/registry'

/**
 * Input for entity autocomplete (`searchEntities`: mentions, reference
 * pickers). Must not import `db`: a server fn's `.validator()` ships to the
 * client bundle. The query that takes it is `entitySearchRows`.
 */
export const entitySearchInput = Schema.Struct({
  q: Schema.String.check(Schema.isMaxLength(120)),
  kinds: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Literals([
          'company',
          'person',
          'deal',
          'space',
          'note',
          'document',
          'custom',
        ]),
      ),
    ),
  ),
  /** narrow to one object's records — a custom-object reference picker */
  objectId: Schema.optional(uuidString),
})

export type EntitySearchInput = typeof entitySearchInput.Type
