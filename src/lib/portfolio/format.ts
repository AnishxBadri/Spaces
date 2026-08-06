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
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: opts?.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts?.compact ? 1 : 0,
  }).format(amount)
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
