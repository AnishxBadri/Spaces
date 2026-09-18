/**
 * What the app decided its public identity is — CONTEXT.md hostability
 * contract #3.
 *
 * The app never terminates TLS and never reads a forwarded header (there is
 * a test pinning that no source file does). `APP_URL` is therefore the only
 * thing that decides the scheme: it is the auth `baseURL`, which is what
 * makes Better Auth's session cookie Secure (`src/lib/auth.ts`); it is the
 * origin of invite links (`src/lib/server/members.ts`); and it is the origin
 * of local blob presign URLs (`src/lib/storage/local.ts`). All three strip a
 * trailing slash and nothing else, so this module does the same — a path
 * component in APP_URL is preserved, because those three preserve it.
 *
 * One misconfiguration is worth a loud warning: a plain-http APP_URL behind
 * a proxy that serves https. The browser then gets a non-Secure cookie on a
 * public host, and the login round-trip silently fails. It is a warning and
 * never a refusal — the required-env set is frozen at {DATABASE_URL,
 * APP_URL} (contract #6) and a plain-http LAN install has to keep working.
 */

export const DEFAULT_APP_URL = 'http://localhost:3000'

/** Hosts where plain http is a legitimate choice, not a misconfiguration. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface ExternalOriginDecision {
  /** Scheme + host (+ port, + path) every external URL is built on. */
  origin: string
  /** Will the session cookie carry Secure? True exactly when origin is https. */
  cookieSecure: boolean
  /** Origin local blob presign URLs are issued on — the same one, by design. */
  presignOrigin: string
  /** Set when the configuration is a probable mistake. Never fatal. */
  warning: string | null
}

/**
 * Pure: takes the raw env value, returns the three facts and any warning.
 * Never throws — an unparseable APP_URL warns and boots.
 */
export function describeExternalOrigin(
  appUrl: string | undefined,
): ExternalOriginDecision {
  const raw = (appUrl ?? '').trim()
  const configured = raw === '' ? DEFAULT_APP_URL : raw
  const origin = configured.replace(/\/$/, '')

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return {
      origin,
      cookieSecure: false,
      presignOrigin: origin,
      warning: `APP_URL is not an absolute URL (${origin || '<empty>'}). Set it to the scheme and host browsers use, e.g. https://deals.example.com.`,
    }
  }

  const cookieSecure = parsed.protocol === 'https:'
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname)
  const warning =
    parsed.protocol === 'http:' && !loopback
      ? `APP_URL is http:// on a non-local host (${parsed.host}). Session cookies will not be Secure. If a reverse proxy serves this app over https, set APP_URL=https://${parsed.host} — the app trusts APP_URL, not the request, so an http APP_URL behind an https proxy means the browser never keeps the login cookie.`
      : null

  return { origin, cookieSecure, presignOrigin: origin, warning }
}

/** The one boot line. All three facts, one place, so the log answers first. */
export function externalOriginLogLine(d: ExternalOriginDecision): string {
  return `[boot] external origin ${d.origin} · cookies secure: ${d.cookieSecure ? 'yes' : 'no'} · presign origin ${d.presignOrigin}`
}

/**
 * Called once per container boot from the migration runner, which the
 * entrypoint runs before either process starts, for every ROLE — so the
 * decision is the first thing in `docker compose logs app`.
 */
export function logExternalOrigin(
  appUrl: string | undefined = process.env.APP_URL,
  log: (message: string) => void = console.log,
  warn: (message: string) => void = console.warn,
): ExternalOriginDecision {
  const decision = describeExternalOrigin(appUrl)
  log(externalOriginLogLine(decision))
  if (decision.warning) warn(`[boot] WARNING: ${decision.warning}`)
  return decision
}
