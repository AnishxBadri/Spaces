/**
 * Whether a Files-tab row offers Read deck (SPA-90). Client-safe and pure,
 * so the rule is one function the row calls and a test can hold.
 *
 * It reads `kind` and `extractionStatus` and nothing else — **kind is
 * kind**: a deck kinded by the filename guesser, by a bound folder's
 * dictionary or by an accepted classify suggestion is the same row, and
 * there is no provenance to branch on. `routed` is `isLaneRouted('extract')`
 * at the record's resolved sensitivity, asked once per tab.
 */
export function offersReadDeck(
  doc: { kind: string; extractionStatus: string },
  routed: boolean,
): boolean {
  return routed && doc.kind === 'deck' && doc.extractionStatus === 'done'
}
