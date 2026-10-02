import { customType } from 'drizzle-orm/pg-core'

/**
 * Postgres types drizzle-orm doesn't ship natively.
 * Extensions (pg_trgm, ltree, unaccent, vector) are created by the first migration.
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
