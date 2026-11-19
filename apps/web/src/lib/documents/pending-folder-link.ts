import { Option, Schema } from 'effect'

/**
 * The Link folder bind a consent detour leaves in sessionStorage: the record,
 * the folder (a pasted link or a picked id), its title and the options. Read
 * back once the dance returns; a boundary, so decoded, never asserted.
 */
const PendingFolderLink = Schema.fromJsonString(
  Schema.Struct({
    entityId: Schema.String,
    folder: Schema.Union([
      Schema.Struct({ url: Schema.String }),
      Schema.Struct({ id: Schema.String }),
    ]),
    title: Schema.String,
    options: Schema.Struct({
      mapSubfolders: Schema.Boolean,
      retain: Schema.Literals(['full', 'text']),
      direction: Schema.Literal('pull'),
      sensitivity: Schema.Literals(['inherit', 'sensitive']),
    }),
  }),
)

export type PendingFolderLink = typeof PendingFolderLink.Type

const decode = Schema.decodeUnknownOption(PendingFolderLink)

/** The stored bind, or null when it is not JSON or not the shape. */
export function pendingFolderLinkOf(raw: string): PendingFolderLink | null {
  return Option.getOrNull(decode(raw))
}
