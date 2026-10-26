import type { AttributeOptions } from '@spaces/db/schema/attributes'

/** The part of a registry row the head reads. */
type RelationDef = {
  readonly type: string
  readonly options: Pick<AttributeOptions, 'targetKind'>
  readonly archived?: boolean | undefined
}

/**
 * Whether a custom object's records link people: a live relation attribute
 * targeting person, either half. Only then does its head carry Log
 * interaction, since an interaction is logged with people.
 */
export function linksPeople(registry: ReadonlyArray<RelationDef>): boolean {
  return registry.some(
    (def) =>
      def.type === 'record_reference' &&
      def.options.targetKind === 'person' &&
      def.archived !== true,
  )
}
