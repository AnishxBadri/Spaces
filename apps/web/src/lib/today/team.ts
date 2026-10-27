/**
 * The team's activity as Today prints it: one sentence per entry, the
 * actor first, no verb code — `Anika Rao filed Q3 board deck.pdf on
 * Exponent`. Pure, so the rail and its test read the same words.
 */

export type TeamEntry = {
  id: string
  verb: string
  at: string
  actorName: string
  subjectName: string | null
  /** What the verb acted on when it is not a record: a filed file's name. */
  objectName: string | null
}

/** A verb's past tense, its subject after it. */
const PHRASES: Record<string, string> = {
  'company.created': 'added',
  'person.created': 'added',
  'record.created': 'added',
  'deal.created': 'opened the deal',
  'note.created': 'wrote a note on',
  'note.filed': 'filed a note on',
  'mark.added': 'recorded a mark on',
  'investment.added': 'recorded a check in',
  'round.added': 'recorded a round for',
  'holding.created': 'opened a holding in',
  'space.created': 'made the space',
  'space.tagged': 'added a record to',
  'space.untagged': 'took a record out of',
  'space.moved': 'moved',
  'space.archived': 'archived',
  'space.restored': 'restored',
  'space.criteria_changed': 'changed the criteria of',
  'note.unfiled': 'unfiled a note from',
  'note.kind_changed': 'changed a note on',
  'note.visibility_changed': 'changed who reads a note on',
  'document.arrived': 'received a file on',
  'document.kind_changed': 'changed a file on',
  'document.reclassified': 'changed a file on',
  'entity.merged': 'merged',
  'entity.enriched': 'enriched',
  'interaction.call': 'logged a call with',
  'term.created': 'defined',
  'mandate.created': 'wrote the mandate',
}

/** `filed Q3 board deck.pdf on Exponent`: what the actor did, to what. */
function phraseOf(e: TeamEntry): string {
  const subject = e.subjectName ?? 'a record'
  if (e.verb === 'document.filed' || e.verb === 'document.refiled')
    return `filed ${e.objectName ?? 'a file'} on ${subject}`
  if (Object.hasOwn(PHRASES, e.verb)) return `${PHRASES[e.verb]} ${subject}`
  // An unnamed verb reads as its words: `space.moved` → `moved Fintech`.
  const action = e.verb.split('.').at(-1) ?? e.verb
  return `${action.replace(/_/g, ' ')} ${subject}`
}

/** The whole line after the time lane. */
export function teamLine(e: TeamEntry): string {
  return `${e.actorName} ${phraseOf(e)}`
}
