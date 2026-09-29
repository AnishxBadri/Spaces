import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, integration } from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'

/**
 * Who wrote a record, resolved to a word a reader recognises.
 *
 * The class alone is only half an answer for one of the eight values:
 * "integration" names no integration. `source_ref` is the other half, and
 * it is exactly the row the operator installed, so the label for a plugin
 * write is its capability id — "apollo", the word on the Integrations page
 * — and for the other seven classes it is the class itself. The left join
 * is a left join because a non-integration row's ref is null by
 * construction; `entity_source_ref_invariant` is what makes that a fact and
 * not a habit.
 *
 * Outside `lib/server/` for the same reason `canRead` is: it takes no request
 * context, `lib/inbox/context.ts` needs it, and a module the client barrel
 * can reach must not import `lib/server/shared.ts` and its `getRequest`
 * (SPA-155). `shared.ts` re-exports it, so nothing else moved.
 */
export async function provenanceOf(entityId: string): Promise<{
  sourceClass: SourceClass
  sourceCapability: string | null
  label: string
}> {
  const row = (
    await db
      .select({
        sourceClass: entity.sourceClass,
        sourceCapability: integration.capabilityId,
      })
      .from(entity)
      .leftJoin(integration, eq(integration.id, entity.sourceRef))
      .where(eq(entity.id, entityId))
  ).at(0)
  if (!row) throw new Error('Entity not found')
  return { ...row, label: channelLabel(row.sourceCapability, row.sourceClass) }
}

/**
 * The word for the writer. A plugin's capability id is already the word on
 * the Integrations page ("apollo"). A core capability is namespaced
 * `core.<channel>` (`core.mailbox`, SPA-56), and the reader wants the
 * channel — "mailbox" on the inbox card of a company a forwarded thread made
 * (SPA-86), not "core.mailbox" and not the bare word "integration".
 */
export function channelLabel(
  capability: string | null,
  sourceClass: SourceClass,
): string {
  if (capability === null) return sourceClass
  return capability.startsWith('core.')
    ? capability.slice('core.'.length)
    : capability
}
