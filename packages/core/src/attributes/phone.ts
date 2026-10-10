/**
 * Phone values are stored in E.164: `+` then 2–15 digits (D67).
 * - `toE164` accepts the punctuation people type between digits and
 *   nothing else; a number without its `+` country code is refused.
 * - `formatPhone` is display only: the country code, then the national
 *   number in groups. Never compared, never stored.
 */

/** The shape a refusal names. */
export const PHONE_SHAPE = '+ then 2–15 digits, like +14155550100'

/** `raw` in E.164, or null when it is not a phone number in that shape. */
export function toE164(raw: string): string | null {
  const s = raw.trim()
  if (!/^\+[\d\s().\-/]+$/.test(s)) return null
  const digits = s.replace(/\D/g, '')
  return digits.length >= 2 && digits.length <= 15 ? `+${digits}` : null
}

/** Why `raw` was refused, naming the shape. */
export const phoneProblem = (raw: string): string =>
  `${raw.trim()} is not a phone number — expected ${PHONE_SHAPE}`

/**
 * Country calling codes of two digits. ITU codes are prefix-free: 1 and 7
 * are one digit, these two, every other three.
 */
const TWO_DIGIT_CODES = new Set(
  (
    '20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 ' +
    '56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98'
  ).split(' '),
)

function codeLength(digits: string): number {
  if (digits.startsWith('1') || digits.startsWith('7')) return 1
  return TWO_DIGIT_CODES.has(digits.slice(0, 2)) ? 2 : 3
}

/** `+14155550100` → `+1 415 555 0100`; `+919845012345` → `+91 98450 12345`. */
export function formatPhone(value: string): string {
  const e164 = toE164(value)
  if (e164 === null) return value
  const digits = e164.slice(1)
  const cc = digits.slice(0, codeLength(digits))
  const national = digits.slice(cc.length)
  if (national.length <= 4) return national ? `+${cc} ${national}` : `+${cc}`
  if (cc === '1' && national.length === 10)
    return `+1 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`
  const half = Math.ceil(national.length / 2)
  return `+${cc} ${national.slice(0, half)} ${national.slice(half)}`
}
