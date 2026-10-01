import { describe, expect, it } from 'vitest'
import { VERB_LABELS, VERB_TYPES } from './record-timeline'

/**
 * Every verb a producer writes to `activity` renders as a sentence, never as
 * its raw name. The portfolio's verbs read `Anish mark.added` on every
 * company record until 2026-09-30 because nothing pinned them; this is the
 * pin. Add a verb to a producer, add it here.
 */
const PRODUCED = [
  // lib/portfolio/holding.ts, write.ts, reverse.ts
  'holding.created',
  'holding.writtenoff',
  'investment.added',
  'investment.voided',
  'investment.batch_voided',
  'round.added',
  'mark.added',
  'mark.voided',
  'mark.batch_voided',
  'distribution.added',
  'distribution.voided',
  'distribution.batch_voided',
  // lib/spaces, lib/glossary, lib/mandate
  'space.created',
  'term.created',
  'mandate.created',
  // packages/core/src/writes/ports/content.ts (sdk-7b)
  'signal.emitted',
  // the record, note and document verbs pinned before
  'record.created',
  'company.created',
  'person.created',
  'deal.created',
  'note.created',
  'note.kind_changed',
  'note.filed',
  'note.unfiled',
  'document.filed',
  'document.refiled',
  'document.kind_changed',
  'document.reextract_requested',
  'space.tagged',
  'space.untagged',
  'entity.merged',
  'renamed',
]

describe('record ledger verbs', () => {
  it.each(PRODUCED)('renders %s as a sentence with a type lane', (verb) => {
    expect(VERB_LABELS[verb], `label for ${verb}`).toBeTruthy()
    expect(VERB_TYPES[verb], `type lane for ${verb}`).toBeTruthy()
  })

  it('keeps every type lane short enough for the 72px lane', () => {
    for (const [verb, type] of Object.entries(VERB_TYPES)) {
      expect(type.length, `${verb} → ${type}`).toBeLessThanOrEqual(8)
    }
  })
})
