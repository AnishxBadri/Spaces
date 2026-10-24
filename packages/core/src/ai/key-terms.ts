import { z } from 'zod'
import type { DocumentKind } from '../documents'
import { JSON_SCHEMA_DRAFT } from './schema'
import type { JsonSchema } from './schema'

/**
 * Key terms: what a legal or diligence document says about a deal's terms,
 * read by the extract lane and landed as a note — never as attribute values.
 * - Hand-written, not compiled by `schemaFor`: terms are read once in the
 *   document's words, never filtered on, so as attributes they would be
 *   mostly-empty columns each claiming a write path. The test snapshot shows
 *   the reviewer the output type the model is handed.
 * - Envelope `{value, refs}`: `refs` non-empty, since every note row cites;
 *   no term required, since a forced model writes "not found".
 */

/** The document kinds that get a key-terms read. */
export const KEY_TERM_KINDS = [
  'legal',
  'dd',
] as const satisfies ReadonlyArray<DocumentKind>

export type KeyTermKind = (typeof KEY_TERM_KINDS)[number]

export const isKeyTermKind = (kind: string): kind is KeyTermKind =>
  KEY_TERM_KINDS.some((k) => k === kind)

export type KeyTermDef = {
  slug: string
  /** The row's first cell, as the note prints it. */
  term: string
  /** What the model is told to look for — the property's description. */
  description: string
}

/**
 * The vocabulary, per kind, in the order the note lists them. A term sheet,
 * a SAFE or a shareholders' agreement is `legal`; a diligence pack, a data
 * room index or a findings memo is `dd`.
 */
export const KEY_TERMS: Record<KeyTermKind, ReadonlyArray<KeyTermDef>> = {
  legal: [
    {
      slug: 'liquidation_preference',
      term: 'Liquidation preference',
      description:
        'The multiple, whether participating or non-participating, any cap, and seniority against other series',
    },
    {
      slug: 'pro_rata',
      term: 'Pro-rata',
      description:
        'Pre-emption or pro-rata rights in future rounds: who holds them, any threshold, and how long they last',
    },
    {
      slug: 'board_composition',
      term: 'Board composition',
      description:
        'Board size, who appoints each seat, observers, and any independent director',
    },
    {
      slug: 'protective_provisions',
      term: 'Protective provisions',
      description:
        'Investor consent or veto rights: the matters listed and the majority needed',
    },
    {
      slug: 'anti_dilution',
      term: 'Anti-dilution',
      description:
        'The anti-dilution protection: full ratchet, or broad-based or narrow-based weighted average',
    },
    {
      slug: 'information_rights',
      term: 'Information rights',
      description:
        'What reporting investors receive, how often, and any ownership threshold for it',
    },
    {
      slug: 'exclusivity',
      term: 'Exclusivity',
      description:
        'A no-shop or exclusivity period: its length and what it forbids',
    },
    {
      slug: 'governing_law',
      term: 'Governing law',
      description: 'The governing law and the jurisdiction for disputes',
    },
  ],
  dd: [
    {
      slug: 'ip_ownership',
      term: 'IP ownership',
      description:
        'Whether the company owns its IP: invention assignment from founders, employees and contractors, and any gap found',
    },
    {
      slug: 'litigation',
      term: 'Litigation',
      description: 'Pending or threatened disputes, claims or proceedings',
    },
    {
      slug: 'material_contracts',
      term: 'Material contracts',
      description:
        'The contracts the business depends on, and any unusual term in them',
    },
    {
      slug: 'change_of_control',
      term: 'Change of control',
      description:
        'Change-of-control, assignment or termination clauses an investment or a sale would trigger',
    },
    {
      slug: 'key_person',
      term: 'Key-person dependency',
      description:
        'Reliance on named individuals, vesting and leaver terms for founders',
    },
    {
      slug: 'regulatory',
      term: 'Regulatory',
      description:
        'Licences, data protection and other regulatory findings or exposures',
    },
    {
      slug: 'open_items',
      term: 'Open items',
      description:
        'Diligence items still outstanding, and red flags the document raises',
    },
  ],
}

const term = (def: KeyTermDef): JsonSchema => ({
  type: 'object',
  title: def.term,
  description: def.description,
  properties: {
    value: {
      type: 'string',
      minLength: 1,
      maxLength: 1000,
      description: 'The term as the document states it, briefly',
    },
    refs: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'Refs of the context items this term was read from',
    },
  },
  required: ['value', 'refs'],
  additionalProperties: false,
})

/**
 * The extract lane's output type for one kind. No property is required: a
 * term the document does not mention is left out, never filled.
 */
export function keyTermsSchema(kind: KeyTermKind): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  for (const def of KEY_TERMS[kind]) properties[def.slug] = term(def)
  return {
    $schema: JSON_SCHEMA_DRAFT,
    title: kind === 'legal' ? 'Key legal terms' : 'Key diligence findings',
    type: 'object',
    properties,
    additionalProperties: false,
  }
}

/** One term the document stated, with where it said it. */
export type KeyTerm = {
  slug: string
  term: string
  value: string
  refs: Array<string>
}

/**
 * The words a model writes when it fills a term it was told to leave out.
 * Such a value is the absence the schema already allows, so it is dropped —
 * the note never prints "not found".
 */
const ABSENT =
  /^(?:not\s+(?:found|stated|mentioned|specified|provided|addressed|disclosed|applicable)|n\/?a|unknown|none\s+(?:stated|mentioned|found)|-+|—)\.?$/i

const answered = z.object({
  value: z.string(),
  refs: z.array(z.string()),
})

/**
 * A provider's answer, held to the schema it was handed, in vocabulary
 * order. A term that is missing, null, empty, "not found", or cites nothing
 * is left out; one that is not the envelope at all, or not a term of this
 * kind, is left out and named in `dropped`.
 */
export function readKeyTerms(
  kind: KeyTermKind,
  raw: unknown,
): { terms: Array<KeyTerm>; dropped: Array<string> } {
  const top = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!top.success) return { terms: [], dropped: [] }
  const defs = KEY_TERMS[kind]
  const terms: Array<KeyTerm> = []
  const dropped: Array<string> = []
  for (const slug of Object.keys(top.data))
    if (!defs.some((d) => d.slug === slug)) dropped.push(slug)
  for (const def of defs) {
    const entry = top.data[def.slug]
    if (entry === undefined || entry === null) continue
    const parsed = answered.safeParse(entry)
    if (!parsed.success) {
      dropped.push(def.slug)
      continue
    }
    const value = parsed.data.value.replace(/\s+/g, ' ').trim()
    const refs = [...new Set(parsed.data.refs.map((r) => r.trim()))].filter(
      (r) => r !== '',
    )
    if (value === '' || ABSENT.test(value) || refs.length === 0) continue
    terms.push({ slug: def.slug, term: def.term, value, refs })
  }
  return { terms, dropped }
}

/** Text that would otherwise read as markdown syntax, or end a table cell. */
const escapeCell = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]|]/g, '\\$&')

/** One row of the note: the term, its value, and where the document said it. */
export type KeyTermRow = { term: string; value: string; citation: string }

/**
 * The note body: a term / value / citation table, one row per term. Every
 * cell is escaped, so a value's own `|` or `*` is text, not structure.
 */
export function keyTermsMarkdown(rows: ReadonlyArray<KeyTermRow>): string {
  return [
    '| Term | Value | Citation |',
    '| --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${escapeCell(r.term)} | ${escapeCell(r.value)} | ${escapeCell(r.citation)} |`,
    ),
  ].join('\n')
}
