/**
 * The ledger's time lane: `MM-DD HH:MM` in the reader's clock.
 *
 * Lifted out of `components/record-timeline.tsx` by SPA-128 so that the
 * write-up's fallback title — `Meeting · 09-18 10:00`, for the synced rows
 * whose `subject` is null — prints an interaction's `occurred_at` in exactly
 * the format the row it hangs off prints it. One implementation, two
 * callers; a second one would drift.
 *
 * A file of its own rather than an export from `timeline/record.ts` because
 * that module imports `@spaces/db`: a component importing it would drag the
 * pg client into the browser bundle (CLAUDE.md → Traps). Nothing here but
 * the string.
 */
export function stamp(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
