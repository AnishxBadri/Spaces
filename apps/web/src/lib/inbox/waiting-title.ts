import { jsonRecord, jsonString } from '@spaces/core/json'
import type { Json } from '@spaces/core/json'
import type { SuggestionKind } from '@spaces/core/writes/suggestions/propose'

/**
 * The one-line title a waiting suggestion reads by on a record's rail:
 * `Founders from Apollo +3` for a patch, the proposed title for a note or a
 * task, the space's label for a space tag, else the kind's own name.
 */

const KIND_TITLES: Record<SuggestionKind, string> = {
  attribute_patch: 'Proposed values',
  note: 'Note',
  ledger_event: 'Ledger event',
  identity: 'Identity',
  document_kind: 'Document kind',
  space_tag: 'Space',
  task: 'Task',
  add_record: 'New company',
  file_record: 'Filing',
  supersedes: 'Newer version',
  refile_document: 'Re-file',
}

export function waitingTitle(
  s: {
    kind: SuggestionKind
    payload: Json
    /** The integration that proposed it, by name; null for the app. */
    source: string | null
  },
  /** An attribute's name by slug; the slug itself when it has none. */
  attributeName: (slug: string) => string,
): string {
  const payload = jsonRecord(s.payload)
  switch (s.kind) {
    case 'attribute_patch': {
      const slugs = Object.keys(payload)
      const first = slugs.at(0)
      if (first === undefined) return KIND_TITLES.attribute_patch
      const from = s.source === null ? '' : ` from ${s.source}`
      const rest = slugs.length > 1 ? ` +${String(slugs.length - 1)}` : ''
      return `${attributeName(first)}${from}${rest}`
    }
    case 'note':
    case 'task':
      return jsonString(payload.title) ?? KIND_TITLES[s.kind]
    case 'space_tag':
      return jsonString(payload.label) ?? KIND_TITLES.space_tag
    default:
      return KIND_TITLES[s.kind]
  }
}
