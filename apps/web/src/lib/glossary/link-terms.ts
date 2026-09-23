import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, link, term } from '@spaces/db/schema'
import { mentionedTermIds, termAutomaton } from '@spaces/core/glossary/terms'

/**
 * Glossary terms as concept nodes (SPA-34; CONTEXT.md → Glossary, "Concept
 * node"). The matcher that highlights a term in the editor runs here too,
 * over a note's `body_md` on save and over a document's `extracted_text`
 * after extraction, and diff-syncs `link(from → term, mentions, extracted)`
 * so the graph learns that PUE was mentioned.
 *
 * Deterministic: no model, no key, no chunks — spec §11's "glossary match"
 * row, whose lane is "none".
 *
 * Lives outside `lib/server/` (SPA-155) so the worker and the tests call it
 * without a request.
 *
 * **The edge rule.** `link_edge_unique` is `(from, to, relation, attr_slug)`
 * whatever the `source`, so a pair carries one `mentions` row at most. The
 * sync owns only `source: 'extracted'` rows: it deletes those alone, and it
 * inserts only where no `mentions` row of any source exists. A manual
 * `mentions` link on the same pair is therefore never deleted and never
 * duplicated — while it stands, the extracted one is simply not written.
 *
 * **Scope.** A term is visible from an entity through the spaces the entity
 * is filed in (`entity_space`) and every ancestor of those (`ltree @>`),
 * plus the global terms (`space_id` null). A note filed in several spaces
 * sees the union; one filed nowhere sees the global terms only. This is the
 * query `listTermsForNote` hands the editor decoration, so the decoration
 * and the sync agree on the term set as well as on the matcher.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Executor = typeof db | Tx

export type ScopedTerm = {
  id: string
  name: string
  aliases: Array<string>
  definitionMd: string
}

/** Terms in scope for an entity — see "Scope" above. */
export async function termsVisibleFrom(
  ex: Executor,
  entityId: string,
): Promise<Array<ScopedTerm>> {
  return ex
    .select({
      id: term.entityId,
      name: term.name,
      aliases: term.aliases,
      definitionMd: term.definitionMd,
    })
    .from(term)
    .where(
      or(
        isNull(term.spaceId),
        // Ancestors too: a note filed in Immersion cooling should know the
        // vocabulary of Cooling and of Data centers above it. Never
        // descendants — a term defined in Cooling says nothing about
        // Aerospace.
        sql`${term.spaceId} in (
          select anc.entity_id from space anc
          join space self on anc.path @> self.path
          join entity_space es on es.space_id = self.entity_id
          where es.entity_id = ${entityId}
        )`,
      ),
    )
    .orderBy(asc(term.name))
}

/** The ids of the in-scope terms `text` mentions, through the shared builder. */
export async function termMentionsIn(
  ex: Executor,
  entityId: string,
  text: string,
): Promise<Set<string>> {
  const terms = await termsVisibleFrom(ex, entityId)
  return mentionedTermIds(termAutomaton(terms), text)
}

/**
 * Which extracted `mentions` rows from an entity a caller owns. A note's
 * save owns all of them — `[[mention]]` chips and glossary matches go
 * through one diff, or each would delete the other's rows. Anything else
 * owns only the rows that point at a term.
 */
export type MentionOwnership = 'all' | 'terms'

export type MentionDiff = {
  added: Array<string>
  removed: Array<string>
}

/**
 * Diff-sync `link(fromId → *, mentions, extracted)` against `wanted`. Writes
 * nothing when nothing changed, which is what makes a re-save or a
 * re-extraction of unchanged text a no-op.
 */
export async function syncExtractedMentions(
  tx: Tx,
  input: {
    fromId: string
    wanted: ReadonlySet<string>
    owns: MentionOwnership
    actorId: string | null
  },
): Promise<MentionDiff> {
  const rows = await tx
    .select({
      id: link.id,
      toEntityId: link.toEntityId,
      source: link.source,
      toKind: entity.kind,
    })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(
      and(
        eq(link.fromEntityId, input.fromId),
        eq(link.relation, 'mentions'),
        eq(link.attrSlug, ''),
      ),
    )

  const present = new Set(rows.map((r) => r.toEntityId))
  const stale = rows.filter(
    (r) =>
      r.source === 'extracted' &&
      (input.owns === 'all' || r.toKind === 'term') &&
      !input.wanted.has(r.toEntityId),
  )
  if (stale.length > 0) {
    await tx.delete(link).where(
      inArray(
        link.id,
        stale.map((r) => r.id),
      ),
    )
  }

  const missing = [...input.wanted].filter(
    (id) => id !== input.fromId && !present.has(id),
  )
  const values: Array<typeof link.$inferInsert> = missing.map((toEntityId) => ({
    fromEntityId: input.fromId,
    toEntityId,
    relation: 'mentions',
    source: 'extracted',
    createdBy: input.actorId,
  }))
  const added =
    values.length === 0
      ? []
      : await tx
          .insert(link)
          .values(values)
          .onConflictDoNothing()
          .returning({ toEntityId: link.toEntityId })

  return {
    added: added.map((r) => r.toEntityId),
    removed: stale.map((r) => r.toEntityId),
  }
}

/**
 * Match `text` against the terms in scope for `fromId` and sync the term
 * mentions it owns. Used where the text is the only source of mentions — a
 * document's `extracted_text`.
 */
export async function linkTermMentionsInTx(
  tx: Tx,
  input: { fromId: string; text: string; actorId: string | null },
): Promise<MentionDiff> {
  const wanted = await termMentionsIn(tx, input.fromId, input.text)
  return syncExtractedMentions(tx, {
    fromId: input.fromId,
    wanted,
    owns: 'terms',
    actorId: input.actorId,
  })
}

export class TermLinkFailed extends Schema.TaggedError<TermLinkFailed>()(
  'TermLinkFailed',
  { cause: Schema.Defect() },
) {}

/**
 * Re-run the glossary match over a document's stored `extracted_text`. The
 * extraction job does the same inside its own write (`markExtracted`), so
 * text and links commit together; this is the standalone form, for a term
 * set that changed after extraction and for the tests.
 */
export const linkDocumentTermsProgram = Effect.fn('linkDocumentTermsProgram')(
  function* (
    documentId: string,
  ): Effect.fn.Return<MentionDiff, TermLinkFailed> {
    return yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const row = (
            await tx
              .select({ text: document.extractedText })
              .from(document)
              .where(eq(document.entityId, documentId))
          ).at(0)
          return linkTermMentionsInTx(tx, {
            fromId: documentId,
            text: row?.text ?? '',
            actorId: null,
          })
        }),
      catch: (cause) => new TermLinkFailed({ cause }),
    })
  },
)
