import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, space } from '@spaces/db/schema'

/**
 * The starter taxonomy — deliberately tiny (CONTEXT.md → Seed taxonomy).
 *
 * An earlier plan shipped 150–250 curated nodes. That was reversed: the tree
 * is the investor's own vocabulary, and a shipped ontology pre-empts it. What
 * remains is a handful of nodes that demonstrate the *shape* — a root, a
 * segment inside it, and the fact that depth is earned — so that a fresh
 * install is not an empty page pretending to be a map.
 *
 * Because it is this small, there is no reconciliation machinery: no seed
 * keys, no rename detection, no upgrade migration. Seeded nodes are ordinary
 * rows the user may rename, move, or delete, and `is_seeded` records only
 * where they came from.
 */

type SeedNode = {
  slug: string
  name: string
  children?: Array<SeedNode>
}

const STARTER: Array<SeedNode> = [
  {
    slug: 'data_centers',
    name: 'Data centers',
    children: [{ slug: 'cooling', name: 'Cooling' }],
  },
  {
    slug: 'aerospace',
    name: 'Aerospace',
    children: [
      { slug: 'in_space_manufacturing', name: 'In-space manufacturing' },
    ],
  },
  { slug: 'fintech', name: 'Fintech' },
]

async function insertNode(
  node: SeedNode,
  parent: { id: string; path: string } | null,
): Promise<void> {
  const path = parent ? `${parent.path}.${node.slug}` : node.slug

  // Idempotent on path, not slug: slugs are unique per parent, so the
  // materialized path is the only stable identity a node has.
  const existing = await db
    .select({ entityId: space.entityId })
    .from(space)
    .where(eq(space.path, path))
    .limit(1)

  let id = existing[0]?.entityId
  if (!id) {
    const [ent] = await db
      .insert(entity)
      .values({
        kind: 'space',
        canonicalName: node.name,
        sourceClass: 'seed',
      })
      .returning({ id: entity.id })
    await db.insert(space).values({
      entityId: ent.id,
      parentId: parent?.id ?? null,
      slug: node.slug,
      path,
      isSeeded: true,
    })
    id = ent.id
  }

  for (const child of node.children ?? []) {
    await insertNode(child, { id, path })
  }
}

/**
 * Runs once, on first boot only. Re-running on every boot would resurrect
 * nodes the operator deliberately deleted — the taxonomy is theirs from the
 * moment they touch it.
 */
export async function seedStarterTaxonomy(): Promise<void> {
  const any = (
    await db.select({ entityId: space.entityId }).from(space).limit(1)
  ).at(0)
  if (any) return

  for (const node of STARTER) await insertNode(node, null)
  console.log(`[taxonomy] seeded ${STARTER.length} starter spaces`)
}
