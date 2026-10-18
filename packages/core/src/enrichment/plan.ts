import { ENRICHMENT_VOCABULARY, isVocabularyKey } from '@spaces/sdk/vocabulary'
import type { VocabularyKey } from '@spaces/sdk/vocabulary'
import type { Json } from '@spaces/db/json'
import { valueValidator } from '../attributes/registry'
import type { AttributeDef } from '../attributes/registry'
import { normalizeDomain } from '@spaces/sdk/identity'
import { toE164 } from '../attributes/phone'

/**
 * The enrichment rules, pure (D76): which linked keys a source is still
 * asked for, and what a run's answers do to a record.
 * - The first source with an answer for a key wins; a later one is kept in
 *   the receipt (`losers`), never a card.
 * - A blank fills, unless a person cleared it.
 * - A value a person holds (or one with no machine writer) is never
 *   touched: a different answer is a `disagreement`, one card per record.
 * - A value another integration holds stands, unless it is a changing
 *   figure and the answer is newer: then it is replaced, and the old figure
 *   is kept in the receipt with its date.
 * - A company answer links a held company only into an empty link, and
 *   anything held stands; a company nobody holds is `unknown`, for the
 *   caller to propose — never created here.
 */

/** An attribute that fills from a vocabulary key. */
export type Link = {
  readonly key: VocabularyKey
  readonly def: AttributeDef
}

/** The live attributes of a registry that carry a vocabulary link. */
export const linksOf = (registry: ReadonlyArray<AttributeDef>): Array<Link> =>
  registry.flatMap((def) => {
    const key = def.options.enrichmentKey
    if (def.archived || key == null || !isVocabularyKey(key)) return []
    return [{ key, def }]
  })

/** Who wrote the value a slug holds now, and when. */
export type Holding = {
  readonly value: Json | null
  /** The latest event's actor; null when the slug has no event. */
  readonly writer: {
    readonly type: 'user' | 'integration' | 'system'
    readonly integrationId: string | null
  } | null
  readonly at: string | null
}

const isBlank = (value: Json | null | undefined) =>
  value === null || value === undefined

const machineHeld = (h: Holding) => h.writer?.type === 'integration'

/** A blank a person left blank — they cleared it — is theirs. */
const cleared = (h: Holding) => isBlank(h.value) && h.writer?.type === 'user'

/**
 * What a source is asked for: linked keys still empty (and not cleared),
 * and changing figures a machine holds — less every key an earlier source
 * in this run already answered.
 */
export const wantedKeys = (
  links: ReadonlyArray<Link>,
  holdings: ReadonlyMap<string, Holding>,
  answered: ReadonlySet<string>,
): Array<string> => {
  const wanted = new Set<string>()
  for (const { key, def } of links) {
    if (answered.has(key)) continue
    const h = holdings.get(def.slug) ?? { value: null, writer: null, at: null }
    if (isBlank(h.value)) {
      if (!cleared(h)) wanted.add(key)
    } else if (ENRICHMENT_VOCABULARY[key].changing && machineHeld(h)) {
      wanted.add(key)
    }
  }
  return [...wanted]
}

/** One source's answers in a run, in vocabulary keys. */
export type SourceAnswer = {
  readonly integrationId: string
  readonly receiptId: string
  /** ISO instant the figures were true as of. */
  readonly asOf: string
  readonly answers: { readonly [key: string]: Json }
}

/**
 * - `filled`: written into a blank; `replaced`: an older machine figure or
 *   this source's own earlier value replaced;
 * - `same`: already held; `kept`: another source's value stands;
 * - `person`: a person's value differs — on the card; `cleared`: a person
 *   cleared it; `invalid`: the attribute's validator refused the answer;
 * - `unknown`: an empty link to a company nobody holds — the caller's to
 *   propose as an add card.
 */
export type FieldOutcome =
  | 'filled'
  | 'replaced'
  | 'same'
  | 'kept'
  | 'person'
  | 'cleared'
  | 'invalid'
  | 'unknown'

export type FieldDecision = {
  readonly key: VocabularyKey
  readonly slug: string
  readonly integrationId: string
  readonly receiptId: string
  readonly value: Json
  readonly asOf: string
  readonly outcome: FieldOutcome
  /** What was held before a `replaced`, `kept` or `person` outcome. */
  readonly previous?: {
    readonly value: Json
    readonly at: string | null
    readonly integrationId: string | null
  }
}

/** An answer recorded but not applied: a later source's, or an unlinked key's. */
export type HeldAnswer = {
  readonly key: string
  readonly integrationId: string
  readonly receiptId: string
  readonly value: Json
  readonly asOf: string
}

export type Decision = {
  readonly fields: ReadonlyArray<FieldDecision>
  readonly losers: ReadonlyArray<HeldAnswer>
  readonly unlinked: ReadonlyArray<HeldAnswer>
}

/**
 * A vocabulary answer in the attribute's write shape: a list joins for
 * text, and a text fills a select as the option whose label it matches
 * exactly — no match stays text, which the validator refuses.
 */
export const toAttributeValue = (def: AttributeDef, value: Json): Json => {
  if (Array.isArray(value) && def.type === 'text') return value.join(', ')
  // A phone answer is one number; a multi phone holds it as a list of one.
  if (def.type === 'phone' && typeof value === 'string') {
    const e164 = toE164(value) ?? value
    return def.options.multi ? [e164] : e164
  }
  if (def.type === 'select' && typeof value === 'string') {
    const label = value.trim()
    const option = (def.options.options ?? []).find(
      (o) => !o.archived && o.label === label,
    )
    return option === undefined ? value : option.id
  }
  return value
}

/** The domain a company answer names, normalized; null when it names none. */
export const companyDomainOf = (value: Json): string | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null
  const domain = value.domain
  return typeof domain === 'string' ? normalizeDomain(domain) : null
}

/** A held reference value as ids. */
const idsOf = (value: Json | null): Array<string> =>
  Array.isArray(value)
    ? value.flatMap((v) => (typeof v === 'string' ? [v] : []))
    : typeof value === 'string'
      ? [value]
      : []

/**
 * A company answer against a reference: the held company by its domain
 * (`companies`), filled only into an empty link.
 */
const companyField = (
  def: AttributeDef,
  holding: Holding,
  raw: Json,
  companies: ReadonlyMap<string, string>,
): { value: Json; outcome: FieldOutcome } => {
  const domain = companyDomainOf(raw)
  const id = domain === null ? undefined : companies.get(domain)
  if (!isBlank(holding.value))
    return {
      value: id ?? raw,
      outcome:
        id !== undefined && idsOf(holding.value).includes(id) ? 'same' : 'kept',
    }
  if (cleared(holding)) return { value: raw, outcome: 'cleared' }
  if (id === undefined)
    return { value: raw, outcome: domain === null ? 'invalid' : 'unknown' }
  return { value: def.options.multi ? [id] : id, outcome: 'filled' }
}

const same = (a: Json | null, b: Json | null) =>
  JSON.stringify(a) === JSON.stringify(b)

const outcomeFor = (
  key: VocabularyKey,
  holding: Holding,
  value: Json,
  answer: SourceAnswer,
): FieldOutcome => {
  if (isBlank(holding.value)) return cleared(holding) ? 'cleared' : 'filled'
  if (same(holding.value, value)) return 'same'
  if (!machineHeld(holding)) return 'person'
  if (holding.writer?.integrationId === answer.integrationId) return 'replaced'
  const newer = holding.at === null || answer.asOf > holding.at
  return ENRICHMENT_VOCABULARY[key].changing && newer ? 'replaced' : 'kept'
}

/** Any other answer: validated in the attribute's shape, then judged. */
const fieldOf = (
  def: AttributeDef,
  key: VocabularyKey,
  holding: Holding,
  raw: Json,
  answer: SourceAnswer,
): { value: Json; outcome: FieldOutcome } => {
  const value = toAttributeValue(def, raw)
  const valid = valueValidator(def, holding.value).safeParse(value)
  return valid.success
    ? {
        value: valid.data,
        outcome: outcomeFor(key, holding, valid.data, answer),
      }
    : { value, outcome: 'invalid' }
}

/**
 * The run's answers, in source order, against what the record holds.
 * `companies` maps a normalized domain to the company that holds it.
 */
export const decide = (
  links: ReadonlyArray<Link>,
  holdings: ReadonlyMap<string, Holding>,
  answers: ReadonlyArray<SourceAnswer>,
  companies: ReadonlyMap<string, string> = new Map(),
): Decision => {
  const byKey = new Map(links.map((l) => [l.key, l]))
  const fields: Array<FieldDecision> = []
  const losers: Array<HeldAnswer> = []
  const unlinked: Array<HeldAnswer> = []
  const won = new Set<string>()
  for (const answer of answers) {
    for (const [key, raw] of Object.entries(answer.answers)) {
      const held: HeldAnswer = {
        key,
        integrationId: answer.integrationId,
        receiptId: answer.receiptId,
        value: raw,
        asOf: answer.asOf,
      }
      const link = isVocabularyKey(key) ? byKey.get(key) : undefined
      if (link === undefined) {
        unlinked.push(held)
        continue
      }
      if (won.has(key)) {
        losers.push(held)
        continue
      }
      won.add(key)
      const { def } = link
      const holding = holdings.get(def.slug) ?? {
        value: null,
        writer: null,
        at: null,
      }
      const decided =
        ENRICHMENT_VOCABULARY[link.key].type === 'company'
          ? companyField(def, holding, raw, companies)
          : fieldOf(def, link.key, holding, raw, answer)
      fields.push({
        key: link.key,
        slug: def.slug,
        integrationId: answer.integrationId,
        receiptId: answer.receiptId,
        value: decided.value,
        asOf: answer.asOf,
        outcome: decided.outcome,
        ...(holding.value === null
          ? {}
          : {
              previous: {
                value: holding.value,
                at: holding.at,
                integrationId: holding.writer?.integrationId ?? null,
              },
            }),
      })
    }
  }
  return { fields, losers, unlinked }
}

/** The fields a decision writes. */
export const written = (decision: Decision): ReadonlyArray<FieldDecision> =>
  decision.fields.filter(
    (f) => f.outcome === 'filled' || f.outcome === 'replaced',
  )

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The run's one timeline line: "Enriched · Website, Apollo · 6 fields ·
 * 1 credit". A free run says no credits; a picture set says so ("logo").
 * A skip the owner should see follows ("Website skipped · sensitive",
 * "Logo skipped · not an image"), and stands alone when nothing ran.
 */
export const enrichedLine = (run: {
  readonly sources: ReadonlyArray<string>
  readonly fields: number
  readonly credits: number
  /** The picture's name when the run set it: "logo", "photo". */
  readonly picture?: string
  readonly skipped?: ReadonlyArray<{
    readonly name: string
    readonly why: string
  }>
}): string =>
  [
    ...(run.sources.length === 0
      ? []
      : [
          'Enriched',
          run.sources.join(', '),
          plural(run.fields, 'field'),
          ...(run.picture === undefined ? [] : [run.picture]),
          ...(run.credits > 0 ? [plural(run.credits, 'credit')] : []),
        ]),
    ...(run.skipped ?? []).map((s) => `${s.name} skipped · ${s.why}`),
  ].join(' · ')
