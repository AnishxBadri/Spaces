import { createHash, randomBytes } from 'node:crypto'

/**
 * PKCE (S256) and where the verifier waits between the two legs: an httpOnly
 * cookie the start route sets and the callback reads and clears.
 * - Named `spaces_pkce_<state nonce>`, so the callback reads the cookie its
 *   verified state names — a cookie from another dance is never found.
 * - Path is the callback's own path; ten-minute life, like the state.
 * - Never inside the state (it would pass through the provider) and never a
 *   row.
 */

export const VERIFIER_TTL_SECONDS = 600

const COOKIE_PREFIX = 'spaces_pkce_'

/** 32 random bytes, base64url: a 43-character verifier (RFC 7636 §4.1). */
export function newVerifier(): string {
  return randomBytes(32).toString('base64url')
}

/** `BASE64URL(SHA256(verifier))` — the S256 challenge. */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function verifierCookieName(nonce: string): string {
  return `${COOKIE_PREFIX}${nonce}`
}

type CookieTarget = {
  readonly nonce: string
  /** The callback's path, e.g. `/api/connections/google/callback`. */
  readonly path: string
  /** True when APP_URL is https. */
  readonly secure: boolean
}

function attributes(path: string, secure: boolean, maxAge: number): string {
  const parts = [
    `Path=${path}`,
    `Max-Age=${String(maxAge)}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** The `Set-Cookie` value the start leg sends. */
export function verifierCookie(
  target: CookieTarget & { readonly verifier: string },
): string {
  return `${verifierCookieName(target.nonce)}=${target.verifier}; ${attributes(target.path, target.secure, VERIFIER_TTL_SECONDS)}`
}

/** The `Set-Cookie` value that clears it, same name and path. */
export function clearVerifierCookie(target: CookieTarget): string {
  return `${verifierCookieName(target.nonce)}=; ${attributes(target.path, target.secure, 0)}`
}

/** The verifier a `Cookie` header carries for this nonce, or null. */
export function readVerifierCookie(
  cookieHeader: string | null,
  nonce: string,
): string | null {
  const name = verifierCookieName(nonce)
  for (const pair of (cookieHeader ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at === -1) continue
    if (pair.slice(0, at).trim() !== name) continue
    const value = pair.slice(at + 1).trim()
    return value === '' ? null : value
  }
  return null
}
