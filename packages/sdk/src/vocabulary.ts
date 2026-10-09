import { z } from 'zod'
import type { JsonValue } from './contract.ts'

/**
 * The enrichment vocabulary: every key a source may answer in (D76). A
 * source answers `company.headcount`, never an attribute slug; the host
 * maps each key to whatever attribute links it (`options.enrichmentKey`).
 * - `kind`: the record kind the key describes.
 * - `type`: the value shape `Facts.answer` accepts for it.
 * - `changing`: a figure that moves over time (headcount, revenue, total
 *   raised). A newer answer replaces one no person set; the old figure stays
 *   in the run's receipt with its date.
 * New keys are an SDK minor; a removed or retyped key is a major.
 */

/** The value shapes a vocabulary key can carry. */
export const VOCABULARY_TYPES = [
  'text',
  'number',
  'url',
  'phone',
  'list',
] as const
export type VocabularyType = (typeof VOCABULARY_TYPES)[number]

export type VocabularyEntry = {
  readonly kind: 'company' | 'person'
  readonly type: VocabularyType
  readonly changing: boolean
}

const fixed = (
  kind: VocabularyEntry['kind'],
  type: VocabularyType,
): VocabularyEntry => ({ kind, type, changing: false })

const changing = (
  kind: VocabularyEntry['kind'],
  type: VocabularyType,
): VocabularyEntry => ({ kind, type, changing: true })

export const ENRICHMENT_VOCABULARY = {
  'company.description': fixed('company', 'text'),
  'company.founded_year': fixed('company', 'number'),
  'company.location': fixed('company', 'text'),
  'company.address': fixed('company', 'text'),
  'company.industry': fixed('company', 'text'),
  'company.keywords': fixed('company', 'list'),
  'company.tech_stack': fixed('company', 'list'),
  'company.linkedin': fixed('company', 'url'),
  'company.twitter': fixed('company', 'url'),
  'company.facebook': fixed('company', 'url'),
  'company.angellist': fixed('company', 'url'),
  'company.crunchbase': fixed('company', 'url'),
  'company.blog': fixed('company', 'url'),
  'company.phone': fixed('company', 'phone'),
  'company.ticker': fixed('company', 'text'),
  'company.headcount': changing('company', 'number'),
  'company.revenue': changing('company', 'number'),
  'company.total_raised': changing('company', 'number'),
  'person.title': fixed('person', 'text'),
  'person.description': fixed('person', 'text'),
  'person.location': fixed('person', 'text'),
  'person.seniority': fixed('person', 'text'),
  'person.department': fixed('person', 'text'),
  'person.linkedin': fixed('person', 'url'),
  'person.twitter': fixed('person', 'url'),
  'person.github': fixed('person', 'url'),
  'person.facebook': fixed('person', 'url'),
  'person.phone': fixed('person', 'phone'),
} as const satisfies { readonly [key: string]: VocabularyEntry }

export type VocabularyKey = keyof typeof ENRICHMENT_VOCABULARY

export const VOCABULARY_KEYS: ReadonlyArray<VocabularyKey> = Object.keys(
  ENRICHMENT_VOCABULARY,
).filter(isVocabularyKey)

export function isVocabularyKey(key: string): key is VocabularyKey {
  return Object.hasOwn(ENRICHMENT_VOCABULARY, key)
}

const VALUE_SCHEMAS: { readonly [T in VocabularyType]: z.ZodType<JsonValue> } =
  {
    text: z.string().trim().min(1),
    number: z.number().finite(),
    url: z.url(),
    phone: z.string().trim().min(1).max(40),
    list: z.array(z.string().trim().min(1)).min(1),
  }

/**
 * Why `value` is not an answer for `key`, or null when it is. An unknown key
 * is named, so the plugin author sees which key the vocabulary lacks.
 */
export function vocabularyProblem(
  key: string,
  value: JsonValue,
): string | null {
  if (!isVocabularyKey(key)) return `${key} is not in the enrichment vocabulary`
  const { type } = ENRICHMENT_VOCABULARY[key]
  return VALUE_SCHEMAS[type].safeParse(value).success
    ? null
    : `${key} takes a ${type}`
}
