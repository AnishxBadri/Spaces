/**
 * One page of a paged list surface, and the step the foot's "load N more" offers.
 * Imports nothing: the client route that draws the foot must not pull
 * `@spaces/db` into the bundle.
 */
export const RECORD_PAGE_SIZE = 50

/** A hostile `limit` still costs one page's work, not the table. */
export const RECORD_PAGE_MAX = 200
