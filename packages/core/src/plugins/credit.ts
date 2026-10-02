/**
 * The words a credit-cap refusal is written in, shared by the worker that
 * writes it to `job_run.summary` and the Today line that reads it back.
 * A cache skip is the other `skipped` reason and never starts with these.
 */
export const CAP_REFUSAL_PREFIX = 'daily credit cap'

export const capRefusal = (cap: number): string =>
  `${CAP_REFUSAL_PREFIX} (${cap}) reached`
