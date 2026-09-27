import { registrableDomain } from '@spaces/core/entities/normalize'

/**
 * Free email providers (D34): a participant on one of these becomes a person
 * and never a company. The one cheap guard against the characteristic
 * failure of create-all — a company called "gmail.com", and a dedupe inbox
 * full of its siblings.
 *
 * Data, owned by the arrival area, and tested (`free-email-domains.test.ts`):
 * every entry is lowercase and is its own registrable domain, so the lookup
 * below — which reduces an address's host to its registrable domain first —
 * can reach it; and the list is a superset of the one
 * `@spaces/core/entities/normalize` refuses to key a company on, so arrival
 * never treats as a work domain what that module would not match.
 *
 * Adding a provider is adding a line. A company that really does work out of
 * one of these domains is a record a human makes by hand.
 */
export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'live.com',
  'live.co.uk',
  'msn.com',
  // Yahoo / AOL
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.co.uk',
  'yahoo.fr',
  'yahoo.de',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Proton, Tuta and the other privacy providers
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'tutanota.com',
  'tuta.io',
  'duck.com',
  'hushmail.com',
  // GMX, web.de, mail.com
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'mail.com',
  // Zoho, Fastmail, HEY
  'zoho.com',
  'zohomail.in',
  'fastmail.com',
  'hey.com',
  // Yandex, Mail.ru
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  // India
  'rediffmail.com',
  // China, Korea
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  // ISP mailboxes
  'comcast.net',
  'att.net',
  'verizon.net',
  'sbcglobal.net',
  'btinternet.com',
  'orange.fr',
])

/**
 * Whether a host — `gmail.com`, `Mail.Yahoo.co.uk` — is a free provider,
 * judged on its registrable domain.
 */
export function isFreeEmailDomain(host: string): boolean {
  const lower = host.trim().toLowerCase()
  if (FREE_EMAIL_DOMAINS.has(lower)) return true
  const registrable = registrableDomain(lower)
  return registrable !== null && FREE_EMAIL_DOMAINS.has(registrable)
}
