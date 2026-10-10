import { LEDGER_CURRENCIES } from '@spaces/core/import/ledger'

/**
 * Currency names as the base-currency picker prints them, `USD · US dollar`.
 * - Hand-written, not `Intl.DisplayNames`: Node and the browser ship different
 *   ICU data, and a name that differs between them fails hydration.
 */
const CURRENCY_NAMES: Readonly<Partial<Record<string, string>>> = {
  USD: 'US dollar',
  EUR: 'Euro',
  GBP: 'British pound',
  INR: 'Indian rupee',
  SGD: 'Singapore dollar',
  JPY: 'Japanese yen',
  CNY: 'Chinese yuan',
  AUD: 'Australian dollar',
  CAD: 'Canadian dollar',
  CHF: 'Swiss franc',
  HKD: 'Hong Kong dollar',
  AED: 'UAE dirham',
  NZD: 'New Zealand dollar',
}

/** `USD · US dollar`; a code with no name reads as the code alone. */
export function currencyLabel(code: string): string {
  const name = CURRENCY_NAMES[code]
  return name === undefined ? code : `${code} · ${name}`
}

/**
 * The codes the base currency may be set to: the ledger's list, with the
 * stored code first when the list lacks it, so a workspace on another
 * currency still reads its own.
 */
export function baseCurrencyCodes(stored: string): ReadonlyArray<string> {
  return LEDGER_CURRENCIES.includes(stored) || stored === ''
    ? LEDGER_CURRENCIES
    : [stored, ...LEDGER_CURRENCIES]
}
