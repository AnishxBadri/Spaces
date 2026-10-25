import { sql } from 'drizzle-orm'
import { space } from '@spaces/db/schema'

/**
 * A space is live when neither it nor any ancestor is archived — an archived
 * space takes its subtree out of the tree and the picker.
 * - Filings stay: readers of a record's spaces keep the row and dim it.
 */
export const liveSpaceSql = sql`not exists (
  select 1 from space arch
  where arch.path @> ${space.path} and arch.archived_at is not null
)`
