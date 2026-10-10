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

/** One country and its ITU calling code, digits only. */
export type CallingCode = { readonly code: string; readonly country: string }

/** `code country;…` — one row per country, so a name finds its code. */
const ITU =
  '1 United States;1 Canada;1 Anguilla;1 Antigua and Barbuda;1 Bahamas;' +
  '1 Barbados;1 Bermuda;1 British Virgin Islands;1 Cayman Islands;' +
  '1 Dominica;1 Dominican Republic;1 Grenada;1 Guam;1 Jamaica;1 Montserrat;' +
  '1 Northern Mariana Islands;1 Puerto Rico;1 Saint Kitts and Nevis;' +
  '1 Saint Lucia;1 Saint Vincent and the Grenadines;1 Sint Maarten;' +
  '1 Trinidad and Tobago;1 Turks and Caicos Islands;1 US Virgin Islands;' +
  '1 American Samoa;7 Russia;7 Kazakhstan;20 Egypt;27 South Africa;' +
  '30 Greece;31 Netherlands;32 Belgium;33 France;34 Spain;36 Hungary;' +
  '39 Italy;39 Vatican City;40 Romania;41 Switzerland;43 Austria;' +
  '44 United Kingdom;44 Guernsey;44 Isle of Man;44 Jersey;45 Denmark;' +
  '46 Sweden;47 Norway;48 Poland;49 Germany;51 Peru;52 Mexico;53 Cuba;' +
  '54 Argentina;55 Brazil;56 Chile;57 Colombia;58 Venezuela;60 Malaysia;' +
  '61 Australia;62 Indonesia;63 Philippines;64 New Zealand;65 Singapore;' +
  '66 Thailand;81 Japan;82 South Korea;84 Vietnam;86 China;90 Türkiye;' +
  '91 India;92 Pakistan;93 Afghanistan;94 Sri Lanka;95 Myanmar;98 Iran;' +
  '211 South Sudan;212 Morocco;213 Algeria;216 Tunisia;218 Libya;' +
  '220 Gambia;221 Senegal;222 Mauritania;223 Mali;224 Guinea;' +
  '225 Côte d’Ivoire;226 Burkina Faso;227 Niger;228 Togo;229 Benin;' +
  '230 Mauritius;231 Liberia;232 Sierra Leone;233 Ghana;234 Nigeria;' +
  '235 Chad;236 Central African Republic;237 Cameroon;238 Cabo Verde;' +
  '239 São Tomé and Príncipe;240 Equatorial Guinea;241 Gabon;' +
  '242 Republic of the Congo;243 DR Congo;244 Angola;245 Guinea-Bissau;' +
  '246 British Indian Ocean Territory;248 Seychelles;249 Sudan;250 Rwanda;' +
  '251 Ethiopia;252 Somalia;253 Djibouti;254 Kenya;255 Tanzania;' +
  '256 Uganda;257 Burundi;258 Mozambique;260 Zambia;261 Madagascar;' +
  '262 Réunion;262 Mayotte;263 Zimbabwe;264 Namibia;265 Malawi;' +
  '266 Lesotho;267 Botswana;268 Eswatini;269 Comoros;290 Saint Helena;' +
  '291 Eritrea;297 Aruba;298 Faroe Islands;299 Greenland;350 Gibraltar;' +
  '351 Portugal;352 Luxembourg;353 Ireland;354 Iceland;355 Albania;' +
  '356 Malta;357 Cyprus;358 Finland;359 Bulgaria;370 Lithuania;371 Latvia;' +
  '372 Estonia;373 Moldova;374 Armenia;375 Belarus;376 Andorra;377 Monaco;' +
  '378 San Marino;380 Ukraine;381 Serbia;382 Montenegro;383 Kosovo;' +
  '385 Croatia;386 Slovenia;387 Bosnia and Herzegovina;389 North Macedonia;' +
  '420 Czechia;421 Slovakia;423 Liechtenstein;500 Falkland Islands;' +
  '501 Belize;502 Guatemala;503 El Salvador;504 Honduras;505 Nicaragua;' +
  '506 Costa Rica;507 Panama;508 Saint Pierre and Miquelon;509 Haiti;' +
  '590 Guadeloupe;591 Bolivia;592 Guyana;593 Ecuador;594 French Guiana;' +
  '595 Paraguay;596 Martinique;597 Suriname;598 Uruguay;599 Curaçao;' +
  '670 Timor-Leste;672 Norfolk Island;673 Brunei;674 Nauru;' +
  '675 Papua New Guinea;676 Tonga;677 Solomon Islands;678 Vanuatu;679 Fiji;' +
  '680 Palau;681 Wallis and Futuna;682 Cook Islands;683 Niue;685 Samoa;' +
  '686 Kiribati;687 New Caledonia;688 Tuvalu;689 French Polynesia;' +
  '690 Tokelau;691 Micronesia;692 Marshall Islands;850 North Korea;' +
  '852 Hong Kong;853 Macao;855 Cambodia;856 Laos;880 Bangladesh;' +
  '886 Taiwan;960 Maldives;961 Lebanon;962 Jordan;963 Syria;964 Iraq;' +
  '965 Kuwait;966 Saudi Arabia;967 Yemen;968 Oman;970 Palestine;' +
  '971 United Arab Emirates;972 Israel;973 Bahrain;974 Qatar;975 Bhutan;' +
  '976 Mongolia;977 Nepal;992 Tajikistan;993 Turkmenistan;994 Azerbaijan;' +
  '995 Georgia;996 Kyrgyzstan;998 Uzbekistan'

/** The ITU calling codes by country name, for the phone editor's picker. */
export const CALLING_CODES: ReadonlyArray<CallingCode> = ITU.split(';')
  .map((row) => {
    const at = row.indexOf(' ')
    return { code: row.slice(0, at), country: row.slice(at + 1) }
  })
  .sort((a, b) => a.country.localeCompare(b.country, 'en'))

/** Digits, spaces and the punctuation people type in a number. */
const NUMBERISH = /^[\d\s().\-/]+$/

/**
 * The codes to offer for what is typed: every code for nothing or a number
 * without its `+`, the codes a `+` prefix could still become, the countries
 * a name matches — and none once a full code is in and the number begun.
 */
export function callingCodesFor(draft: string): ReadonlyArray<CallingCode> {
  const s = draft.trim()
  if (s === '' || NUMBERISH.test(s)) return CALLING_CODES
  if (s.startsWith('+')) {
    const digits = s.replace(/\D/g, '')
    if (digits === '') return CALLING_CODES
    const full = digits.length >= codeLength(digits)
    if (digits.length > codeLength(digits) || (full && /\s$/.test(draft)))
      return []
    return CALLING_CODES.filter((c) => c.code.startsWith(digits))
  }
  const q = s.toLowerCase()
  return CALLING_CODES.filter((c) => c.country.toLowerCase().includes(q))
}

/** `draft` with `code` in front: a typed national number is kept after it. */
export function withCallingCode(draft: string, code: string): string {
  const s = draft.trim()
  return NUMBERISH.test(s) ? `+${code} ${s}` : `+${code} `
}
