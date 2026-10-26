/**
 * The record notices band's lines, in words: a possible duplicate and a
 * parked enrichment. Pure, so the band, its server read and the tests share
 * one wording.
 */

/** The side of a duplicate pair that is not this record. */
export type RecordDuplicate = {
  readonly pairId: string
  readonly otherId: string
  readonly otherName: string
  /** What both records carry — a shared domain, else the name matched on. */
  readonly key: string | null
}

/** One side of a sweep pair, as the review queue reads it. */
type PairSide = {
  readonly id: string
  readonly name: string
  readonly domains: ReadonlyArray<string>
  readonly identityDomain: string | null
}

type Pair = {
  readonly id: string
  readonly reason: { readonly [why: string]: string }
  readonly a: PairSide
  readonly b: PairSide
}

const domainsOf = (side: PairSide): Array<string> =>
  side.identityDomain === null
    ? [...side.domains]
    : [...side.domains, side.identityDomain]

/** A sweep pair read from `recordId`'s side. */
export function duplicateOf(pair: Pair, recordId: string): RecordDuplicate {
  const [self, other] =
    pair.a.id === recordId ? [pair.a, pair.b] : [pair.b, pair.a]
  const theirs = new Set(domainsOf(other))
  const shared = domainsOf(self).find((d) => theirs.has(d))
  const matched = Object.values(pair.reason).at(0)
  return {
    pairId: pair.id,
    otherId: other.id,
    otherName: other.name,
    key: shared ?? matched ?? null,
  }
}

export function duplicateWords(d: RecordDuplicate): string {
  return d.key === null
    ? `Possibly the same as ${d.otherName}`
    : `Possibly the same as ${d.otherName} · ${d.key} on both`
}

/** A source's daily cap holding this record's enrichment until its reset. */
export type ParkedEnrich = {
  readonly source: string
  /** ISO instant the parked run becomes due. */
  readonly resumesAt: string
}

const two = (n: number) => String(n).padStart(2, '0')

export function parkedWords(p: ParkedEnrich): string {
  const at = new Date(p.resumesAt)
  return `Enrich parked · ${p.source} limit reached · runs at ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`
}
