import { getDomain } from 'tldts'

/**
 * Normalization rules for identity keys, per CONTEXT.md. These functions
 * are the ONLY place normalization happens — every alias write and every
 * lookup goes through them, or matching silently rots.
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

/** Role-prefixed emails are never person-identity. */
const ROLE_PREFIXES = new Set([
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
  const raw = input.trim().toLowerCase()
  if (!raw) return null
  const domain = getDomain(raw, { allowPrivateDomains: false })
  if (!domain) return null
  if (FREE_MAIL.has(domain)) return null
  return domain
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.has(domain.toLowerCase())
}

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
