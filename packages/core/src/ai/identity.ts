import { z } from 'zod'

/**
 * The `suggestion(kind: 'identity')` payload (SPA-105, spec-ai-substrate.md
 * §11): a person a document names, as the document names them. Not an id —
 * accepting it is what walks the claim through `resolveEntity`, the one door
 * every creator uses, which decides attach or create.
 *
 * One decoder, three readers: `proposeProgram` holds a new row to it, the
 * accept path reads it back before resolving, and the inbox card draws it.
 */
export const identityPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    role: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().max(255).optional(),
    linkedin: z.string().trim().min(1).max(500).optional(),
  })
  .strict()

/**
 * Spelled out rather than `z.infer`: an absent key is absent, never an
 * `undefined` value, so the payload is JSON by type and lands in the jsonb
 * column without a second decode.
 */
export type IdentityPayload = {
  name: string
  role?: string
  email?: string
  linkedin?: string
}

/** A stored payload read as an identity, or null when it is not one. */
export function readIdentityPayload(raw: unknown): IdentityPayload | null {
  const parsed = identityPayloadSchema.safeParse(raw)
  return parsed.success ? identityPayloadOf(parsed.data) : null
}

/**
 * A person claim off `toPatch` (an `IdentityClaim`), or a decoded payload →
 * the payload. `domain` is dropped: it is a company's key, and the person
 * claim schema never asks for one.
 */
export function identityPayloadOf(claim: {
  name: string
  role?: string | undefined
  email?: string | undefined
  linkedin?: string | undefined
}): IdentityPayload {
  return {
    name: claim.name,
    ...(claim.role === undefined ? {} : { role: claim.role }),
    ...(claim.email === undefined ? {} : { email: claim.email }),
    ...(claim.linkedin === undefined ? {} : { linkedin: claim.linkedin }),
  }
}
