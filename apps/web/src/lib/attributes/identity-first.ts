import type { AttributeOptions } from '@spaces/core/attributes/registry'

/**
 * A registry with its identity attributes first — a person's emails, a
 * company's domains — so a list shows them beside the name. Order is
 * otherwise the registry's.
 */
export function identityFirst<
  TDef extends { options: AttributeOptions | null },
>(registry: ReadonlyArray<TDef>): Array<TDef> {
  const isIdentity = (d: TDef) => d.options?.identityKey !== undefined
  return [
    ...registry.filter(isIdentity),
    ...registry.filter((d) => !isIdentity(d)),
  ]
}
