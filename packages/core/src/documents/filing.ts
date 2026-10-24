/**
 * Where a document is filed. Two mechanisms, never mixed, the same split
 * notes carry: a record files through `link(tagged_in)`, a space files
 * through `entity_space`, which gives a space-filed document the
 * source/confidence provenance every other member of a space has.
 *
 * A discriminated union rather than a bare uuid so "a space is a link
 * target" is not expressible: the caller says which mechanism it means, and
 * the writer checks the entity agrees.
 */
export type DocumentFilingTarget =
  { kind: 'record'; entityId: string } | { kind: 'space'; entityId: string }

/**
 * Why this entity may not take this filing, or `null` if it may. Pure and
 * shared, so the server fn's early refusal and the writer's own guard cannot
 * drift apart — the server fn refuses before the storage probe's cost is
 * spent, the writer refuses whoever calls it without one.
 *
 * `space` and `document` are the two refusals on the record side: a space is
 * filed *into*, and a document filed against a document is a mention.
 */
export function documentFilingRefusal(
  target: DocumentFilingTarget,
  entityKind: string,
): string | null {
  if (target.kind === 'space') {
    return entityKind === 'space'
      ? null
      : `A document files into a space through entity_space — that target is a ${entityKind}.`
  }
  if (entityKind === 'space')
    return 'A space is filed into, not against — file the document into it.'
  if (entityKind === 'document')
    return 'A document is filed against a record, not against another document.'
  return null
}
