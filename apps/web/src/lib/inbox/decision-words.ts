import { readIdentityPayload } from '@spaces/core/ai/identity'
import { readLedgerEventPayload } from '@spaces/core/ai/ledger-event'
import type { CapturedPage, SuggestionItem } from './queue'

/**
 * The words a suggestion is decided with, one list for Review and Today:
 * the primary verb, and `Dismiss` for the other way. Pure, so Today's rows,
 * Review's cards and their tests read the same spelling.
 */

export type DecisionWords = {
  accept: string
  reject: string
  /** The dismiss button's tooltip; null for none. */
  rejectTitle: string | null
}

const DISMISS_TITLE =
  'Dismiss for good: this domain is never suggested in this space again'

const words = (accept: string, rejectTitle: string | null = null) => ({
  accept,
  reject: 'Dismiss',
  rejectTitle,
})

/**
 * A suggestion's verbs. The kind decides them, and two read their payload:
 * a ledger event says what it records, and a person a captured page names
 * is filed on by name.
 */
export function decisionWords(
  item: Pick<SuggestionItem, 'kind' | 'payload'>,
  page: CapturedPage | null = null,
): DecisionWords {
  switch (item.kind) {
    case 'add_record':
      return words('Add and file', DISMISS_TITLE)
    case 'file_record':
      return words('File here', DISMISS_TITLE)
    case 'ledger_event':
      return words(
        readLedgerEventPayload(item.payload)?.event === 'round'
          ? 'Record round'
          : 'Record mark',
      )
    case 'refile_document':
      return words('Re-file')
    case 'supersedes':
      return words(
        'Mark as newer version',
        'Dismiss for good: this pair is not suggested again',
      )
    case 'space_tag':
      return words('Add to space')
    case 'note':
      return words('Add note')
    case 'task':
      return words('Add task')
    case 'identity': {
      const claim = page === null ? null : readIdentityPayload(item.payload)
      return words(claim === null ? 'Accept' : `File on ${claim.name}`)
    }
    case 'attribute_patch':
    case 'document_kind':
      return words('Accept')
  }
}
