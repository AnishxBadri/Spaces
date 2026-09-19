import { customType } from 'drizzle-orm/pg-core'

/**
 * Postgres types drizzle-orm doesn't ship natively.
 * Extensions (pg_trgm, ltree, unaccent, vector) are created in migration 0000.
 */

export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

export const ltree = customType<{ data: string }>({
  dataType() {
    return 'ltree'
  },
})
