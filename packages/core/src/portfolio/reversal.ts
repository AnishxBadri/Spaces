/**
 * The as-of gate on a voided ledger event (D12, SPA-150).
 *
 * A correction is an append: the void writes a compensating event carrying
 * the *original's* date, so cost basis, MOIC and XIRR return to exactly
 * their pre-entry values — the pair cancels at every as-of date on or after
 * the original. What distinguishes the two rows is `created_at`: the
 * reversal's is the instant somebody decided the entry was wrong.
 *
 * That instant is what `reversedAt` carries. A reader asking "as on 2024-06-30"
 * about a mark voided in 2025 is asking what was believed then, and then the
 * mark was live — so a reversal is in effect only once the as-of day has
 * reached the void. Comparison is lexical on the date prefix, which is the
 * end-of-day reading the rest of the ledger uses for dates.
 *
 * **Nothing here depends on the negated amount.** The loader hands the pure
 * libs only originals — the compensating rows never arrive — because none of
 * the derived numbers net to zero under a negative row: `holdingMetrics`
 * picks the *latest* mark, `writtenOff` derives from the latest write-off
 * distribution, and `ownership()` filters `shares > 0`. The negation is
 * stored so a raw `SUM` over the table stays honest and the timeline can
 * show both rows; it is not how the metrics get their answer.
 */

/** An event that may have been voided by a compensating event citing it. */
export type Reversible = {
  /**
   * ISO timestamp of the reversal's `created_at` — the void instant — or
   * null/absent while the event stands. Never the reversal's `date`, which
   * is the original's.
   */
  reversedAt?: string | null | undefined
}

/**
 * Is the void in effect at `asOf`? An absent `asOf` means "everything",
 * which includes every void that has happened.
 */
export function reversalInEffect(
  reversedAt: string | null | undefined,
  asOf?: string | undefined,
): boolean {
  if (reversedAt === null || reversedAt === undefined) return false
  return asOf === undefined || reversedAt.slice(0, 10) <= asOf
}

/** The events that still stand at `asOf` — reversed ones drop out. */
export function liveAt<T extends Reversible>(
  events: Array<T>,
  asOf?: string | undefined,
): Array<T> {
  return events.filter((e) => !reversalInEffect(e.reversedAt, asOf))
}
