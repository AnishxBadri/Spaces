import {
  isRoleEmail,
  normalizeDomain,
  normalizeEmail,
  registrableDomain,
} from '@spaces/core/entities/normalize'
import type { Address } from './forwarded'
import { isFreeEmailDomain } from './free-email-domains'
import { isRoleSender } from './noise'

/**
 * Which participants become records (SPA-86, arrival-2; D34 option 1).
 * Parsed addresses in, one typed decision per address out — no database and
 * no network, because the same judgement decides what a forwarded thread, a
 * calendar attendee (arrival-5), a recorder participant (arrival-6) and a
 * synced Gmail thread (arrival-10) do to the graph, and it is proven by a
 * table in `participants.test.ts` with no Postgres.
 *
 * The policy is **create-all-visible, minus a free-provider list** (CONTEXT.md
 * "Email / calendar ingestion" records why it beat SENT-only):
 *
 * - **create** — a person keyed by the address, and a company keyed by the
 *   address's registrable domain when it is a work domain. A free provider
 *   (`free-email-domains.ts`) yields the person and no company. A shared
 *   inbox at a work domain (`founders@`, `hello@` — `isRoleEmail`) yields the
 *   company and no person: a role address identifies nobody, and
 *   `resolveEntity` would refuse it as a person key anyway.
 * - **attach** — the workspace's own people: a member's address, or any
 *   address at one of the workspace's own domains. Nothing is ever created
 *   for them; the interaction still names them when a record already exists.
 *   This is the rule that keeps the fund out of its own pipeline on day one,
 *   and it is settled whichever creation policy wins.
 * - **ignore** — a machine (`noreply@`, `notifications@`: the sender list
 *   `noise.ts` refuses whole messages on), a role address at a free
 *   provider, or an address that does not parse.
 *
 * `create` means "create if absent": every survivor goes through
 * `resolveEntity`, which attaches on an identity key it already knows. The
 * decision is what the address is *allowed* to cause, not what it will.
 */

export type ParticipantsInput = {
  from: Address | null
  to: ReadonlyArray<Address>
  cc: ReadonlyArray<Address>
  /** The workspace's own domains — any form; reduced to registrable here. */
  ownDomains: ReadonlyArray<string>
  /** Every workspace member's address — any case; normalized here. */
  memberEmails: ReadonlyArray<string>
}

export type PersonToCreate = {
  /** The address as written, lowercased; `resolveEntity` normalizes the key. */
  email: string
  /** The display name, when the header carried a real one. */
  name: string | null
}

export type CompanyToCreate = {
  /** The registrable domain — the identity key. */
  domain: string
  /** Its first label, title-cased: `acme-robotics.io` → `Acme Robotics`. */
  name: string
}

export type ParticipantDecision =
  | {
      action: 'create'
      address: string
      person: PersonToCreate | null
      company: CompanyToCreate | null
    }
  | { action: 'attach'; address: string; reason: 'member' | 'own-domain' }
  | { action: 'ignore'; address: string; reason: 'role' | 'malformed' }

/**
 * One decision per distinct address, in header order: From, To, Cc. Each
 * decision's `address` is the normalized form (`normalizeEmail`), which is
 * also what two spellings of one Gmail address dedupe on.
 */
export function decideParticipants(
  input: ParticipantsInput,
): Array<ParticipantDecision> {
  const members = new Set(
    input.memberEmails
      .map((e) => normalizeEmail(e))
      .filter((e): e is string => e !== null),
  )
  // A free provider is never "ours", whatever the caller passed: a member
  // on Gmail must not make every Gmail participant internal.
  const own = new Set(
    input.ownDomains
      .filter((d) => !isFreeEmailDomain(d))
      .map((d) => registrableDomain(d))
      .filter((d): d is string => d !== null),
  )
  const seen = new Set<string>()
  const out: Array<ParticipantDecision> = []
  for (const a of [
    ...(input.from === null ? [] : [input.from]),
    ...input.to,
    ...input.cc,
  ]) {
    const key = normalizeEmail(a.email) ?? a.email.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(decide(a, members, own))
  }
  return out
}

function decide(
  a: Address,
  members: ReadonlySet<string>,
  own: ReadonlySet<string>,
): ParticipantDecision {
  const raw = a.email.trim()
  const email = wellFormed(raw) ? normalizeEmail(raw) : null
  if (email === null)
    return { action: 'ignore', address: raw, reason: 'malformed' }
  const host = email.slice(email.lastIndexOf('@') + 1)
  const registrable = registrableDomain(host)
  if (registrable === null)
    return { action: 'ignore', address: email, reason: 'malformed' }

  // Membership first: a member is attached even from a free provider, and
  // even when their address happens to read like a machine's.
  if (members.has(email))
    return { action: 'attach', address: email, reason: 'member' }
  if (own.has(registrable))
    return { action: 'attach', address: email, reason: 'own-domain' }

  if (isRoleSender(email))
    return { action: 'ignore', address: email, reason: 'role' }

  const free = isFreeEmailDomain(host)
  const workDomain = free ? null : normalizeDomain(host)
  const company: CompanyToCreate | null =
    workDomain === null
      ? null
      : { domain: workDomain, name: companyName(workDomain) }
  const person: PersonToCreate | null = isRoleEmail(email)
    ? null
    : { email: raw.toLowerCase(), name: displayName(a.name) }

  if (person === null && company === null)
    return { action: 'ignore', address: email, reason: 'role' }
  return { action: 'create', address: email, person, company }
}

/**
 * The shape `normalizeEmail` does not check: one `@`, a non-empty local part
 * with no whitespace or brackets, and a host of dot-separated labels.
 */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i
function wellFormed(address: string): boolean {
  const at = address.lastIndexOf('@')
  if (at <= 0 || address.indexOf('@') !== at) return false
  const local = address.slice(0, at)
  if (/[\s<>()[\],;:"]/.test(local)) return false
  return HOST.test(address.slice(at + 1))
}

/**
 * A display name worth keeping as the record's name: not blank, not the
 * address again, not an address at all.
 */
function displayName(name: string | null): string | null {
  if (name === null) return null
  const trimmed = name
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim()
  if (trimmed === '' || trimmed.includes('@')) return null
  return trimmed
}

/** `acme-robotics.co.uk` → `Acme Robotics`: the label the registrant chose. */
export function companyName(domain: string): string {
  const label = domain.slice(0, domain.indexOf('.'))
  const words = label.split(/[-_]+/).filter((w) => w !== '')
  if (words.length === 0) return domain
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
