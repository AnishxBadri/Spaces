import { describe, expect, it } from 'vitest'
import { VERB_LABELS, VERB_TYPES } from './record-timeline'

/**
 * Every verb a producer writes to `activity` renders as a sentence, never as
 * its raw name (`Anish mark.added`). Add a verb to a producer, add it here.
 */
const PRODUCED = [
  // The portfolio ledger: births, writes and voids.
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
  // Spaces, the glossary, the mandate.
  'space.created',
  'term.created',
  'mandate.created',
  // A plugin's `Content.emitSignal`.
  'signal.emitted',
  // An enrichment run.
  'entity.enriched',
  // The record, note and document verbs.
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
  'document.arrived',
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
