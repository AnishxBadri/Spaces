import { count, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'

/**
 * **Is any document row still on this digest?** — the one question both
 * directions of blob GC ask, asked in one place (SPA-54).
 *
 * Content addressing means one file backs several rows: the deck emailed to
 * both partners, the same deck filed on a company and on a space. So "delete
 * the bytes" is never a consequence of deleting *a* row — it is a
 * consequence of the last row going. Until this slice the count lived inline
 * at the bottom of `deleteDocumentWithBlobGc`, which was fine while a delete
 * was the only thing that could strand bytes. The orphan sweep reclaims from
 * the other direction — a prepare whose finalize never came — and asks the
 * identical question, so a second copy of the query would be two places that
 * must stay in step about what "referenced" means. `blob-refs.test.ts`
 * asserts there is only one.
 *
 * It lives in `lib/documents/` and **not** in `lib/server/`: the server-fns
 * barrel re-exports `lib/server/*` wholesale to the browser and a plain
 * export there ships with it (CLAUDE.md → Traps, SPA-155), while the worker
 * and the delete path both have to call this without a request.
 */
export async function blobIsReferenced(sha: string): Promise<boolean> {
  // `.at(0)` rather than a destructure: drizzle types the element as
  // always-present, which is a claim about a result set rather than one the
  // compiler checked (CLAUDE.md gate 4).
  const row = (
    await db
      .select({ value: count() })
      .from(document)
      .where(eq(document.blobSha, sha))
  ).at(0)
  return (row?.value ?? 0) > 0
}
