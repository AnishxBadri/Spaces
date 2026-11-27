import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { detectFormat } from '@spaces/core/documents/extract'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import { serverQuery } from '#/lib/server/query'
import type { ServerQueryFailed } from '#/lib/server/query'
import { findHits } from './find-text'
import type { FindHits } from './find-text'

/**
 * The viewer's find: a query over one file's stored text, the hits grouped
 * by the page they are on. Null for a file the viewer may not read, as for
 * one that is gone. The text never leaves the server here; only the counts.
 */
export const findInDocumentProgram = Effect.fn('findInDocumentProgram')(
  function* (
    viewer: { readonly id: string },
    documentId: string,
    query: string,
  ): Effect.fn.Return<FindHits | null, ServerQueryFailed> {
    const row = (yield* serverQuery(() =>
      db
        .select({
          text: document.extractedText,
          filename: document.filename,
          mime: document.mime,
        })
        .from(document)
        .where(
          and(eq(document.entityId, documentId), canReadDocumentSql(viewer.id)),
        ),
    )).at(0)
    if (row === undefined) return null
    return findHits(row.text ?? '', detectFormat(row.filename, row.mime), query)
  },
)
