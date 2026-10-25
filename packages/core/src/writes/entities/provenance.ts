import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, integration } from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'

/**
 * Who wrote a record, resolved to a word a reader recognises. For an
 * `integration` row the class names no integration, so the label is the
 * `source_ref` row's capability id ("apollo"); for the other classes it is
 * the class. The join is a left join because a non-integration row's ref is
 * null, which `entity_source_ref_invariant` guarantees.
 *
 * Takes no request context, so a module the client barrel reaches can use it
 * without importing `getRequest`.
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
 * `core.<channel>` (`core.mailbox`), and the reader wants the channel —
 * "mailbox" on the inbox card of a company a forwarded thread made, not
 * "core.mailbox" and not the bare word "integration".
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
