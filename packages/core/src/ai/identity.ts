import { Schema } from 'effect'
import { object, readFirst, text } from './decode'

/**
 * The `suggestion(kind: 'identity')` payload: a person a document names, as
 * the document names them. Not an id —
 * accepting it is what walks the claim through `resolveEntity`, the one door
 * every creator uses, which decides attach or create.
 *
 * One decoder, three readers: `proposeProgram` holds a new row to it, the
 * accept path reads it back before resolving, and the inbox card draws it.
 */
export const identityPayloadSchema = object(
  {
    name: text({ trim: true, min: 1, max: 500 }),
    role: Schema.optional(text({ trim: true, min: 1, max: 200 })),
    email: Schema.optional(text({ trim: true, format: 'email', max: 255 })),
    linkedin: Schema.optional(text({ trim: true, min: 1, max: 500 })),
    /**
     * The slug of the person-reference attribute the claim was read off:
     * `founders` on a company, `people` or `referred_by` on a deal.
     * Accepting writes the resolved person into it. Optional because older
     * rows carry none — those accept with the person alone (a company record
     * also joins the person's `companies`).
     */
    attribute: Schema.optional(text({ trim: true, min: 1, max: 100 })),
  },
  { strict: true },
)

/**
 * Spelled out rather than the schema's type: an absent key is absent,
 * never an `undefined` value, so the payload is JSON by type and lands in
 * the jsonb column without a second decode.
 */
export type IdentityPayload = {
  name: string
  role?: string
  email?: string
  linkedin?: string
  attribute?: string
}

/** A stored payload read as an identity, or null when it is not one. */
export function readIdentityPayload(raw: unknown): IdentityPayload | null {
  const parsed = readFirst(identityPayloadSchema, raw)
  return parsed.success
    ? identityPayloadOf(parsed.data, parsed.data.attribute)
    : null
}

/**
 * A person claim off `toPatch` (an `IdentityClaim`), or a decoded payload →
 * the payload. `domain` is dropped: it is a company's key, and the person
 * claim schema never asks for one. `attribute` is the slug of the field the
 * claim was read off, which accepting writes the person into.
 */
export function identityPayloadOf(
  claim: {
    name: string
    role?: string | undefined
    email?: string | undefined
    linkedin?: string | undefined
  },
  attribute?: string,
): IdentityPayload {
  return {
    name: claim.name,
    ...(claim.role === undefined ? {} : { role: claim.role }),
    ...(claim.email === undefined ? {} : { email: claim.email }),
    ...(claim.linkedin === undefined ? {} : { linkedin: claim.linkedin }),
    ...(attribute === undefined ? {} : { attribute }),
  }
}
