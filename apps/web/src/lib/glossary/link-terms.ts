import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, link, term } from '@spaces/db/schema'
import { mentionedTermIds, termAutomaton } from '@spaces/core/glossary/terms'

/**
 * Glossary terms as concept nodes: the editor's term matcher, run over a
 * note's `body_md` on save and a document's `extracted_text`, diff-syncing
 * `link(from → term, mentions, extracted)`. Deterministic: no model, no key.
 * Kept out of the server-fn barrel so the worker and tests call it directly.
 *
 * **The edge rule.** `link_edge_unique` ignores `source`, so a pair carries
 * one `mentions` row at most. The sync deletes only `extracted` rows and
 * inserts only where no `mentions` row exists: a manual link is never
 * deleted or duplicated.
 *
 * **Scope.** Terms of the entity's spaces and their ancestors (`ltree @>`),
 * plus global terms (`space_id` null). `listTermsForNote` hands the editor
 * the same set, so decoration and sync agree.
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
