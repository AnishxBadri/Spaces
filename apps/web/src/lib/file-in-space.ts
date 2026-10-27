import { FolderInput } from 'lucide-react'
import { toast } from 'sonner'
import type { PageAction, StepChoice, StepCreate } from './page-actions'
import { createSpace, listSpaces, tagIntoSpace } from './server-fns'

type SpaceRow = {
  id: string
  name: string
  parentId: string | null
  companies: number
}

/** A space's label with its ancestors: `Proptech › Property ops`. */
export function spacePathLabel(
  row: SpaceRow,
  byId: ReadonlyMap<string, SpaceRow>,
): string {
  const names = [row.name]
  let parent = row.parentId === null ? undefined : byId.get(row.parentId)
  while (parent) {
    names.unshift(parent.name)
    parent = parent.parentId === null ? undefined : byId.get(parent.parentId)
  }
  return names.join(' › ')
}

/** The top of a space's tree: itself when it has no parent. */
function rootOf(row: SpaceRow, byId: ReadonlyMap<string, SpaceRow>): SpaceRow {
  let at = row
  let parent = at.parentId === null ? undefined : byId.get(at.parentId)
  while (parent) {
    at = parent
    parent = at.parentId === null ? undefined : byId.get(at.parentId)
  }
  return at
}

/**
 * The step's answers: every live space by its path, the ones it is filed in
 * checked with `Filed here`, the rest with their bare company count, and
 * `· n subspaces` on a space with children.
 */
export function spaceChoices(
  rows: ReadonlyArray<SpaceRow>,
  filedIds: ReadonlySet<string>,
): Array<StepChoice> {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const children = new Map<string, number>()
  for (const r of rows)
    if (r.parentId !== null)
      children.set(r.parentId, (children.get(r.parentId) ?? 0) + 1)
  return rows.map((r) => {
    const subspaces = children.get(r.id) ?? 0
    const tail =
      subspaces === 0
        ? ''
        : ` · ${String(subspaces)} subspace${subspaces === 1 ? '' : 's'}`
    const label = spacePathLabel(r, byId)
    return filedIds.has(r.id)
      ? { id: r.id, label, meta: `Filed here${tail}`, done: true }
      : { id: r.id, label, meta: `${String(r.companies)}${tail}` }
  })
}

/**
 * The create row for a query no space is named exactly: under the root of
 * the best match, or at the top when nothing matched.
 */
export function newSpaceRow(
  query: string,
  shown: ReadonlyArray<StepChoice>,
  rows: ReadonlyArray<SpaceRow>,
): { name: string; root: SpaceRow | null } | null {
  const name = query.trim()
  if (name === '') return null
  const lower = name.toLowerCase()
  if (rows.some((r) => r.name.toLowerCase() === lower)) return null
  const byId = new Map(rows.map((r) => [r.id, r]))
  const best = shown.at(0)
  const bestRow = best === undefined ? undefined : byId.get(best.id)
  return { name, root: bestRow === undefined ? null : rootOf(bestRow, byId) }
}

/**
 * Cmd-K's "File in a space…": asks for the space in the palette, files the
 * record there with `tagIntoSpace`, and stays open for another.
 * - A query no space is named offers `+ New space "<query>"`, which makes
 *   the space and files the record in it.
 * - The row's lane says how many spaces hold it now: `in 2 now`.
 * - The list is the space picker's own `listSpaces`.
 */
export function fileInSpaceAction(record: {
  id: string
  name: string
  filedIds: ReadonlyArray<string>
}): PageAction {
  const filed = new Set(record.filedIds)
  let rows: Array<SpaceRow> = []

  async function fileIn(spaceId: string, label: string) {
    await tagIntoSpace({ data: { entityId: record.id, spaceId } })
    filed.add(spaceId)
    toast(`Filed ${record.name} in ${label}`)
  }

  function create(
    query: string,
    shown: ReadonlyArray<StepChoice>,
  ): StepCreate | null {
    const row = newSpaceRow(query, shown, rows)
    if (row === null) return null
    const { name, root } = row
    return {
      label: `New space "${name}"`,
      lane: root === null ? 'Top level' : `Under ${root.name}`,
      make: async () => {
        try {
          const { id } = await createSpace({
            data: { name, ...(root === null ? {} : { parentId: root.id }) },
          })
          const made: SpaceRow = {
            id,
            name,
            parentId: root?.id ?? null,
            companies: 0,
          }
          rows = [...rows, made]
          const label = spacePathLabel(
            made,
            new Map(rows.map((r) => [r.id, r])),
          )
          await fileIn(id, label)
          return { id, label, meta: 'Filed here', done: true }
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : 'Could not make the space',
          )
          throw err
        }
      },
    }
  }

  return {
    id: 'file-in-space',
    label: 'File in a space…',
    icon: FolderInput,
    words: 'tag space file',
    ...(filed.size > 0 ? { meta: `in ${String(filed.size)} now` } : {}),
    step: {
      mode: 'File in',
      subject: record.name,
      placeholder: 'Find a space…',
      heading: 'Spaces',
      choices: async () => {
        rows = await listSpaces()
        return spaceChoices(rows, filed)
      },
      pick: async (choice) => {
        try {
          await fileIn(choice.id, choice.label)
          // The subspaces tail stays; the count gives way to Filed here.
          const meta = choice.meta ?? ''
          const at = meta.indexOf(' · ')
          const tail = at === -1 ? '' : meta.slice(at)
          return { ...choice, meta: `Filed here${tail}`, done: true }
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : 'Could not file it there',
          )
          throw err
        }
      },
      create,
    },
  }
}
