import { z } from 'zod'
import { liveOptions } from '../attributes/options'
import { valueValidator } from '../attributes/registry'
import type { AttributeDef } from '../attributes/registry'

/**
 * The registry is the output type system (docs/spec-ai-substrate.md §2).
 * `schemaFor` compiles an object's attribute registry into the JSON schema a
 * provider is handed as structured output; `validateProposal` holds what
 * comes back to the same validators a human write meets; `toPatch` turns a
 * valid proposal into the patch `planPatch` takes. Nothing here knows about
 * a model, a provider or a database — a custom object is extractable-into
 * the moment its attributes exist, with no AI-specific code.
 *
 * **The envelope (settled here, SPA-21).** Every property is wrapped
 * `{value, refs, confidence}`: the review UI needs "from p.4" per field, and
 * a per-field split cannot be recovered from a row-level list. The
 * suggestion row's own `refs[]` is the derived union (`proposalRefs`) —
 * cheap to compute from the split, while the reverse is impossible.
 */

/** What the compiler reads off an attribute — a registry row satisfies it. */
export type SchemaAttribute = Pick<
  AttributeDef,
  'slug' | 'name' | 'type' | 'options' | 'archived'
> & {
  /** `attribute.description` (migration 0020) — the property's description */
  description?: string | null
}

/** The slice of JSON Schema draft 2020-12 the compiler emits. */
export type JsonSchema = {
  $schema?: string
  title?: string
  description?: string
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  properties?: Record<string, JsonSchema>
  required?: Array<string>
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: Array<string>
  format?: string
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
}

export const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema'

/**
 * A record_reference is proposed as an identity claim, never a uuid: a model
 * reading a deck knows "Sequoia, sequoiacap.com", not a row id. The claim is
 * resolved at accept time through the identity write path.
 */
export type IdentityClaim = {
  name: string
  domain?: string
  email?: string
  /** A person's LinkedIn URL — an identity key `resolveEntity` matches on. */
  linkedin?: string
  /** A person's role as the context states it ("CEO") — shown, never matched. */
  role?: string
}

/** One proposed field — the envelope every property wears. */
export type ProposedField = {
  value: unknown
  /** ContextItem refs (spec §1) the value was read from */
  refs: Array<string>
  confidence: number
}

export type Proposal = Record<string, ProposedField>

export type ProposalIssue = { slug: string; message: string }

export type ProposalCheck =
  { ok: true; proposal: Proposal } | { ok: false; issues: Array<ProposalIssue> }

/**
 * Types a model may write. `actor_reference` is absent on purpose: no model
 * assigns a human owner, so the type has no write shape here at all.
 */
function writeShape(def: SchemaAttribute): JsonSchema | null {
  switch (def.type) {
    case 'text':
      return { type: 'string', maxLength: 2000 }
    case 'domain':
      return { type: 'string', format: 'hostname', maxLength: 255 }
    case 'email':
      return { type: 'string', format: 'email', maxLength: 255 }
    case 'url':
      return { type: 'string', format: 'uri', maxLength: 500 }
    case 'phone':
      return {
        type: 'string',
        maxLength: 40,
        description: 'A phone number, as written',
      }
    case 'number':
      return { type: 'number' }
    case 'currency':
      return def.options.code
        ? { type: 'number', description: `An amount in ${def.options.code}` }
        : { type: 'number' }
    case 'rating':
      return { type: 'integer', minimum: 1, maximum: def.options.max ?? 5 }
    case 'date':
      return {
        type: 'string',
        format: 'date',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      }
    case 'checkbox':
      return { type: 'boolean' }
    case 'select':
    case 'status': {
      // Live ids only: an archived option is history, not vocabulary.
      const ids = liveOptions(def).map((o) => o.id)
      return ids.length > 0 ? { type: 'string', enum: ids } : null
    }
    case 'multi_select': {
      const ids = liveOptions(def).map((o) => o.id)
      return ids.length > 0
        ? {
            type: 'array',
            items: { type: 'string', enum: ids },
            uniqueItems: true,
            maxItems: 50,
          }
        : null
    }
    case 'record_reference': {
      // A person is claimed by the keys a person has (SPA-105): email and
      // LinkedIn, which `resolveEntity` matches on, and the role the deck
      // gives them. Every other target keeps the company-shaped claim.
      const claim =
        def.options.targetKind === 'person' ? PERSON_CLAIM_SCHEMA : CLAIM_SCHEMA
      return def.options.multi
        ? { type: 'array', items: claim, maxItems: 100 }
        : claim
    }
    case 'actor_reference':
      return null
  }
}

const CLAIM_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 500 },
    domain: { type: 'string', format: 'hostname', maxLength: 255 },
    email: { type: 'string', format: 'email', maxLength: 255 },
  },
  required: ['name'],
  additionalProperties: false,
}

const PERSON_CLAIM_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 500 },
    role: {
      type: 'string',
      maxLength: 200,
      description: 'Their role or title, as the context states it',
    },
    email: { type: 'string', format: 'email', maxLength: 255 },
    linkedin: { type: 'string', format: 'uri', maxLength: 500 },
  },
  required: ['name'],
  additionalProperties: false,
}

const envelope = (def: SchemaAttribute, value: JsonSchema): JsonSchema => ({
  type: 'object',
  title: def.name,
  ...(def.description ? { description: def.description } : {}),
  properties: {
    value,
    refs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Refs of the context items this value was read from',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['value', 'refs', 'confidence'],
  additionalProperties: false,
})

/**
 * Registry → the structured-output schema. Archived attributes and types
 * with no write shape drop out.
 *
 * No property is `required`, whatever the attribute's own `required` says.
 * A required attribute means a human cannot clear it; it does not mean a
 * deck states it. A model forced to fill a field it cannot find invents one,
 * and an invented value is worse than an absent one — so absence is always
 * a legal answer, and `required` stays the write path's concern.
 */
export function schemaFor(
  registry: ReadonlyArray<SchemaAttribute>,
  title?: string,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  for (const def of registry) {
    if (def.archived) continue
    const shape = writeShape(def)
    if (shape) properties[def.slug] = envelope(def, shape)
  }
  return {
    $schema: JSON_SCHEMA_DRAFT,
    ...(title ? { title } : {}),
    type: 'object',
    properties,
    additionalProperties: false,
  }
}

const claimValidator = z
  .object({
    name: z.string().trim().min(1).max(500),
    domain: z.string().max(255).optional(),
    email: z.string().email().max(255).optional(),
    linkedin: z.string().trim().min(1).max(500).optional(),
    role: z.string().trim().min(1).max(200).optional(),
  })
  .strict()

const fieldValidator = z
  .object({
    value: z.unknown(),
    refs: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  })
  .strict()

function validateValue(def: SchemaAttribute, value: unknown) {
  if (def.type === 'record_reference')
    return def.options.multi
      ? z.array(claimValidator).max(100).safeParse(value)
      : claimValidator.safeParse(value)
  // No `held`: a proposal is always a fresh assertion. A record keeping an
  // archived option it already holds is the write path's allowance for a
  // human editing around history; a model naming that option is asserting
  // it anew, which is exactly what archiving forbids.
  return valueValidator(def).safeParse(value)
}

/**
 * A provider's output, held to the same validators as a human write. The
 * schema already constrains a well-behaved provider; this is the check that
 * does not trust it to have.
 */
export function validateProposal(
  registry: ReadonlyArray<SchemaAttribute>,
  raw: unknown,
): ProposalCheck {
  const top = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!top.success)
    return {
      ok: false,
      issues: [{ slug: '', message: 'A proposal is an object keyed by slug' }],
    }
  const bySlug = new Map(registry.map((d) => [d.slug, d]))
  const issues: Array<ProposalIssue> = []
  const proposal: Proposal = {}

  for (const [slug, entry] of Object.entries(top.data)) {
    const def = bySlug.get(slug)
    if (!def || def.archived) {
      issues.push({ slug, message: `${slug}: Unknown attribute` })
      continue
    }
    if (def.type === 'actor_reference') {
      issues.push({
        slug,
        message: `${slug}: an owner is assigned by a person, never proposed`,
      })
      continue
    }
    const field = fieldValidator.safeParse(entry)
    if (!field.success) {
      issues.push({
        slug,
        message: `${slug}: expected {value, refs, confidence}`,
      })
      continue
    }
    const value = validateValue(def, field.data.value)
    if (!value.success) {
      issues.push({
        slug,
        message: `${slug}: ${value.error.issues[0]?.message ?? 'Invalid value'}`,
      })
      continue
    }
    proposal[slug] = {
      value: value.data,
      refs: field.data.refs,
      confidence: field.data.confidence,
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, proposal }
}

/**
 * A valid proposal → the patch `planPatch` takes, plus the identity claims
 * held aside: a claim is not a value until the identity write path has
 * resolved it to a record, and that is a database step this module does not
 * take.
 */
export function toPatch(
  registry: ReadonlyArray<SchemaAttribute>,
  proposal: Proposal,
): {
  patch: Record<string, unknown>
  claims: Record<string, Array<IdentityClaim>>
} {
  const bySlug = new Map(registry.map((d) => [d.slug, d]))
  const patch: Record<string, unknown> = {}
  const claims: Record<string, Array<IdentityClaim>> = {}
  for (const [slug, field] of Object.entries(proposal)) {
    const def = bySlug.get(slug)
    if (!def) continue
    if (def.type === 'record_reference') {
      const parsed = z
        .array(claimValidator)
        .safeParse(Array.isArray(field.value) ? field.value : [field.value])
      if (parsed.success) claims[slug] = parsed.data.map(stripClaim)
      continue
    }
    patch[slug] = field.value
  }
  return { patch, claims }
}

const stripClaim = (c: z.infer<typeof claimValidator>): IdentityClaim => ({
  name: c.name,
  ...(c.domain === undefined ? {} : { domain: c.domain }),
  ...(c.email === undefined ? {} : { email: c.email }),
  ...(c.linkedin === undefined ? {} : { linkedin: c.linkedin }),
  ...(c.role === undefined ? {} : { role: c.role }),
})

/** The suggestion row's `refs[]`: the union of every field's, first-seen order. */
export function proposalRefs(proposal: Proposal): Array<string> {
  return [...new Set(Object.values(proposal).flatMap((f) => f.refs))]
}
