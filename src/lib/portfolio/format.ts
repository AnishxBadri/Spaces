/**
 * Display formatting for the Portfolio surfaces. Client-safe (no server
 * imports). Money is compact by default — a portfolio table is about
 * magnitudes, the detail view shows exact figures.
 */

export function fmtMoney(
  amount: number,
  currency: string,
  opts?: { compact?: boolean },
): string {
  // Compact is hand-rolled: Intl's compact notation differs across ICU
  // builds (Node vs browser), which breaks SSR hydration.
  if (opts?.compact) {
    const abs = Math.abs(amount)
    const sign = amount < 0 ? '-' : ''
    const symbol = currencySymbol(currency)
    if (abs >= 1e9) return `${sign}${symbol}${trim1(abs / 1e9)}B`
    if (abs >= 1e6) return `${sign}${symbol}${trim1(abs / 1e6)}M`
    if (abs >= 1e3) return `${sign}${symbol}${trim1(abs / 1e3)}K`
    return `${sign}${symbol}${Math.round(abs)}`
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount)
}

function trim1(x: number): string {
  const s = x.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

function currencySymbol(currency: string): string {
  const part = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  })
    .formatToParts(0)
    .find((p) => p.type === 'currency')
  return part?.value ?? `${currency} `
}

export function fmtMultiple(x: number | null): string {
  return x === null ? '—' : `${x.toFixed(2)}×`
}

export function fmtPct(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`
}

export function fmtXirr(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  })
}
