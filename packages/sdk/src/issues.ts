import { Predicate, SchemaIssue } from 'effect'

const standard = SchemaIssue.makeFormatterStandardSchemaV1()

/** A path segment as a plain key: the formatter may wrap one as `{ key }`. */
export const segmentKey = (
  s: PropertyKey | { readonly key: PropertyKey },
): PropertyKey => (Predicate.isObject(s) ? s.key : s)

/** Each issue as `{ path, message }`, the path's keys plain. */
export const issuesOf = (
  issue: SchemaIssue.Issue,
): Array<{
  readonly path: ReadonlyArray<PropertyKey>
  readonly message: string
}> =>
  standard(issue).issues.map(({ message, path }) => ({
    path: (path ?? []).map(segmentKey),
    message,
  }))

/** `cap: Expected …; criteria: Missing key` — a root issue stands alone. */
export const issueText = (issue: SchemaIssue.Issue): string =>
  issuesOf(issue)
    .map(({ path, message }) =>
      path.length === 0 ? message : `${path.map(String).join('.')}: ${message}`,
    )
    .join('; ')
