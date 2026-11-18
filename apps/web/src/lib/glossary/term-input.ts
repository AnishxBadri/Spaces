import { Effect, Schema } from 'effect'
import type { TermPatch } from './write-term'

/**
 * The term server fns' input schemas, outside `lib/server/` so a test can
 * decode through them without a request. Client-safe: the validators are
 * evaluated in the client bundle too, so this imports `write-term` as a
 * type only.
 */

const uuid = Schema.String.check(Schema.isUUID())

const termName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
)

const aliases = Schema.Array(termName).check(Schema.isMaxLength(20))
const definitionMd = Schema.Trim.check(Schema.isMaxLength(4000))
const spaceId = Schema.optional(Schema.NullOr(uuid))

/** A new term: an absent list or definition reads as empty. */
export const createTermInput = Schema.Struct({
  name: termName,
  aliases: aliases.pipe(
    Schema.withDecodingDefault(Effect.succeed<ReadonlyArray<string>>([])),
  ),
  definitionMd: definitionMd.pipe(
    Schema.withDecodingDefault(Effect.succeed('')),
  ),
  spaceId,
})

/**
 * An edit: a field left out keeps what is stored. No defaults, or an edit
 * of the name alone would save the aliases and definition as empty.
 */
export const updateTermInput = Schema.Struct({
  id: uuid,
  name: Schema.optional(termName),
  aliases: Schema.optional(aliases),
  definitionMd: Schema.optional(definitionMd),
  spaceId,
})

/** The write's patch: only the fields that came in, no `undefined` keys. */
export function termPatchOf(data: typeof updateTermInput.Type): TermPatch {
  return {
    id: data.id,
    ...(data.name === undefined ? {} : { name: data.name }),
    ...(data.aliases === undefined ? {} : { aliases: [...data.aliases] }),
    ...(data.definitionMd === undefined
      ? {}
      : { definitionMd: data.definitionMd }),
    ...(data.spaceId === undefined ? {} : { spaceId: data.spaceId }),
  }
}
