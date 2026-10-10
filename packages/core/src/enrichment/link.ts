import { VOCABULARY_KEYS } from '@spaces/sdk/vocabulary'
import type { VocabularyKey } from '@spaces/sdk/vocabulary'
import { enrichmentLinkProblem } from '../attributes/registry'
import type { AttributeType } from '../attributes/registry'

/**
 * "Fill from" (D76): which vocabulary keys an attribute may link, and the
 * words a key is shown by. Client-safe — the attribute window imports it.
 */

/** The keys an attribute of `type` on a `kind` record can fill from, in vocabulary order. */
export const linkableKeys = (
  type: AttributeType,
  kind: 'company' | 'person',
  targetKind?: string | null,
): ReadonlyArray<VocabularyKey> =>
  VOCABULARY_KEYS.filter(
    (key) => enrichmentLinkProblem(type, kind, key, targetKind) === null,
  )

/** `company.founded_year` → `founded year`. */
export const keyWord = (key: string): string =>
  (key.split('.').at(1) ?? key).replaceAll('_', ' ')

/** `Website, then Apollo` — the sources an Enrich asks, in order. */
export const askWords = (names: ReadonlyArray<string>): string =>
  names.length <= 1
    ? (names.at(0) ?? '')
    : `${names.slice(0, -1).join(', ')}, then ${names.at(-1) ?? ''}`
