import {
  Option,
  Predicate,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
} from 'effect'
import { uuidString } from '../attributes/registry'

/**
 * The `suggestion(kind: 'refile_document')` payload: a document a storage
 * source brought whose folder now resolves to another record.
 * - Decoded by `proposeWith` on insert, by the accept path before it moves
 *   the edge, and by the Review card.
 * - The ids are what accept writes; the names are as filed when proposed.
 * - `sourcePath` is the provider folder the file now sits in.
 */

const named = Schema.String.check(Schema.isMinLength(1))

export const refileDocumentPayloadSchema = Schema.Struct({
  documentId: uuidString,
  fromEntityId: uuidString,
  toEntityId: uuidString,
  sourcePath: Schema.String,
  documentName: named,
  fromName: named,
  toName: named,
})
  .check(
    Schema.makeFilter(
      (p) =>
        p.fromEntityId !== p.toEntityId ||
        'a re-file names two different records',
    ),
  )
  // After the check: annotating before it leaves the excess-key option off.
  .annotate({ parseOptions: { onExcessProperty: 'error' } })

export type RefileDocumentPayload = {
  documentId: string
  fromEntityId: string
  toEntityId: string
  sourcePath: string
  documentName: string
  fromName: string
  toName: string
}

/** One refusal: the dotted path of the field it names (empty for the whole), and why. */
export type RefileIssue = { readonly path: string; readonly message: string }

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** A stored payload decoded as a re-file proposal, or every refusal by field. */
export function decodeRefileDocumentPayload(
  raw: unknown,
): Result.Result<RefileDocumentPayload, ReadonlyArray<RefileIssue>> {
  const decoded = SchemaParser.decodeUnknownResult(
    refileDocumentPayloadSchema,
    { errors: 'all' },
  )(raw)
  if (Result.isSuccess(decoded)) return Result.succeed(decoded.success)
  return Result.fail(
    formatIssues(decoded.failure).issues.map(({ path, message }) => ({
      path: (path ?? [])
        .map((s) => String(Predicate.isObject(s) ? s.key : s))
        .join('.'),
      message,
    })),
  )
}

/** A stored payload read as a re-file proposal, or null when it is not one. */
export function readRefileDocumentPayload(
  raw: unknown,
): RefileDocumentPayload | null {
  return Option.getOrNull(
    Schema.decodeUnknownOption(refileDocumentPayloadSchema)(raw),
  )
}
