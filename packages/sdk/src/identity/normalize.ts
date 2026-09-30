import { getDomain } from 'tldts'

/**
 * Normalization rules for identity keys, per CONTEXT.md. These functions
 * are the ONLY place normalization happens — every alias write and every
 * lookup goes through them, or matching silently rots.
 *
 * In `@spaces/sdk` since SPA-195 (sdk-4b), moved whole from
 * `packages/core/src/entities/normalize.ts`, which now re-exports this file:
 * a plugin normalizes an identity claim's keys exactly as the choke point
 * (`resolveEntity`) does, because it is the same code. Its one import is
 * `tldts`, the SDK's third dependency (D55).
 */

/** Free-mail domains never create or match a company. */
const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'zoho.com',
  'zohomail.in',
  'yandex.com',
  'yandex.ru',
  'mail.com',
  'rediffmail.com',
  'fastmail.com',
  'hey.com',
])

/**
 * Role-prefixed emails are never person-identity. The one list (SPA-195):
 * `identity/one-list.test.ts` fails if a second appears in packages/core or
 * packages/sdk. apps/web's `ROLE_SENDERS` (arrival/noise.ts) filters mail
 * noise — a different job — and is not this list.
 */
export const ROLE_PREFIXES: ReadonlySet<string> = new Set([
  'info',
  'hello',
  'hi',
  'team',
  'contact',
  'support',
  'sales',
  'careers',
  'jobs',
  'admin',
  'office',
  'mail',
  'press',
  'legal',
  'finance',
  'billing',
  'accounts',
  'noreply',
  'no-reply',
  'notifications',
  'founders',
  'partners',
  'invest',
  'investors',
  'pitch',
  'deals',
])

/** Legal suffixes stripped from company names before fuzzy matching. */
const LEGAL_SUFFIXES =
  /\s+(inc|incorporated|ltd|limited|llc|llp|plc|pvt\.?\s*ltd|private\s+limited|gmbh|sas|sarl|bv|ab|as|oy|kk|pte\.?\s*ltd|co|corp|corporation|company|holdings|labs|technologies|tech)\.?$/i

/**
 * Domain → registrable domain (eTLD+1), lowercase. Accepts bare domains,
 * URLs, and emails-shaped input. Returns null for invalid or free-mail.
 */
export function normalizeDomain(input: string): string | null {
  const domain = registrableDomain(input)
  if (!domain) return null
  if (FREE_MAIL.has(domain)) return null
  return domain
}

/**
 * Host → registrable domain (eTLD+1), lowercase, free-mail or not; null when
 * the host has none. `normalizeDomain` minus the free-mail refusal, for the
 * caller that has to *ask* whether a host is a free provider rather than be
 * told nothing (the arrival lane's participant judgement, SPA-86).
 */
export function registrableDomain(input: string): string | null {
  const raw = input.trim().toLowerCase()
  if (!raw) return null
  return getDomain(raw, { allowPrivateDomains: false })
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.has(domain.toLowerCase())
}

/**
 * The free-mail set itself, read-only — for the arrival lane's own list
 * (`apps/web/src/lib/arrival/free-email-domains.ts`, D34), whose test holds
 * it to a superset of this one.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = FREE_MAIL

/**
 * Email → matching form. Lowercase always; gmail additionally strips dots
 * and +tags (dot-insensitive, tag-insensitive) — other providers treat
 * dots as significant, so only gmail gets that treatment.
 * Returns null for invalid shapes.
 */
export function normalizeEmail(input: string): string | null {
  const raw = input.trim().toLowerCase()
  const at = raw.lastIndexOf('@')
  if (at <= 0 || at === raw.length - 1) return null
  let local = raw.slice(0, at)
  const domain = raw.slice(at + 1)
  if (!domain.includes('.')) return null
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replaceAll('.', '')
    return `${local}@gmail.com`
  }
  return `${local}@${domain}`
}

/** Role-prefixed emails (info@, careers@…) never identify a person. */
export function isRoleEmail(email: string): boolean {
  const at = email.indexOf('@')
  if (at <= 0) return false
  const local = email.slice(0, at).toLowerCase().split('+')[0]
  return ROLE_PREFIXES.has(local)
}

/**
 * Name → fuzzy-match form: lowercase, diacritics stripped, legal suffixes
 * dropped, whitespace collapsed. Feeds pg_trgm only — never identity.
 */
export function normalizeName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(LEGAL_SUFFIXES, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** LinkedIn URL → canonical path form: linkedin.com/in/slug or /company/slug. */
export function normalizeLinkedin(input: string): string | null {
  const raw = input.trim().toLowerCase()
  const m = raw.match(
    /linkedin\.com\/(in|company|school)\/([a-z0-9\-_%.]+?)\/?(?:[?#].*)?$/,
  )
  if (!m) return null
  return `linkedin.com/${m[1]}/${decodeURIComponent(m[2])}`
}

/** Indian CIN: 21 chars, uppercase. Structural check only. */
export function normalizeCin(input: string): string | null {
  const raw = input.trim().toUpperCase().replace(/\s/g, '')
  return /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(raw) ? raw : null
}

/**
 * URL → absolute http(s) href. A bare host (`acme.com/about`) gains
 * `https://`, which is what a spreadsheet column of websites almost always
 * holds; any other scheme, whitespace, or a host without a dot is null. Not
 * an identity key — LinkedIn identity is `normalizeLinkedin` — but the one
 * place a URL somebody else typed becomes one the registry's `url` validator
 * accepts (SPA-166: the importer calls this rather than a copy of it).
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw || /\s/.test(raw)) return null
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(absolute)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // Credentials are never a web address somebody meant — and a scheme-less
  // `mailto:a@acme.com` would otherwise parse as user `mailto` at acme.com.
  if (url.username || url.password) return null
  if (!url.hostname.includes('.')) return null
  return url.href
}

/**
 * A domain as a record shows it: the host `normalizeUrl` reads, lowercase,
 * without a leading `www.` — `https://www.Example.com/` is `example.com`,
 * `app.deel.com/login` stays `app.deel.com`. The display half of a domain
 * identity alias (SPA-173); what it matches on is `normalizeDomain`'s eTLD+1
 * in `value_norm`, and this never feeds a comparison. Null when the input
 * reads as no web host.
 */
export function domainHost(input: string): string | null {
  const href = normalizeUrl(input)
  if (href === null) return null
  const host = new URL(href).hostname
  return host.startsWith('www.') ? host.slice(4) : host
}

/**
 * Phone → matching form: a leading `+` when one was written, then the digits.
 * Accepts the punctuation people type (spaces, dashes, dots, parentheses,
 * slashes) and nothing else, and 7–15 digits, E.164's ceiling. A stored phone
 * stays as written; this answers "is it a phone number" and "which one".
 */
export function normalizePhone(input: string): string | null {
  const raw = input.trim()
  if (!/^\+?[\d\s().\-/]+$/.test(raw)) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return `${raw.startsWith('+') ? '+' : ''}${digits}`
}
