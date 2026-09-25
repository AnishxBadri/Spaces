import { isKeyTermKind } from '@spaces/core/ai/key-terms'

/**
 * Whether a Files-tab row offers Extract key terms (SPA-91). Client-safe and
 * pure, as `offersReadDeck` is, so the rule is one function the row calls
 * and a test can hold.
 *
 * - the kind is `legal` or `dd` — **kind is kind**, however it was set;
 * - the text is extracted;
 * - the filing reaches a deal: one of the document's `tagged_in` edges is a
 *   deal record. With none, the terms have nowhere to belong, and the row
 *   offers nothing rather than a button that would only refuse;
 * - `routed` is `isLaneRouted('extract')` at the record's resolved
 *   sensitivity, asked once per tab.
 */
export function offersKeyTerms(
  doc: {
    kind: string
    extractionStatus: string
    filedIn: ReadonlyArray<
      { kind: 'record'; entityKind: string } | { kind: 'space' }
    >
  },
  routed: boolean,
): boolean {
  return (
    routed &&
    isKeyTermKind(doc.kind) &&
    doc.extractionStatus === 'done' &&
    doc.filedIn.some((e) => e.kind === 'record' && e.entityKind === 'deal')
  )
}
