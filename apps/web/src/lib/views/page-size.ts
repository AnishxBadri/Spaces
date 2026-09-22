/**
 * One page of a paged list surface (SPA-64), and the step the foot's
 * "load N more" offers.
 *
 * Its own module because both halves need it and they may not share one:
 * `records.ts` reaches for `@spaces/db`, and the route that draws the foot
 * must not pull that into the client bundle. This file imports nothing.
 */
export const RECORD_PAGE_SIZE = 50

/** A hostile `limit` still costs one page's work, not the table. */
export const RECORD_PAGE_MAX = 200
