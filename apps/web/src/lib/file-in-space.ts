import { FolderInput } from 'lucide-react'
import { toast } from 'sonner'
import type { PageAction, StepChoice } from './page-actions'
import { listSpaces, tagIntoSpace } from './server-fns'

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

/** The step's answers: every live space, the ones it is filed in checked. */
export function spaceChoices(
  rows: ReadonlyArray<SpaceRow>,
  filedIds: ReadonlySet<string>,
): Array<StepChoice> {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return rows.map((r) =>
    filedIds.has(r.id)
      ? {
          id: r.id,
          label: spacePathLabel(r, byId),
          meta: 'filed here',
          done: true,
        }
      : {
          id: r.id,
          label: spacePathLabel(r, byId),
          meta: `${String(r.companies)} compan${r.companies === 1 ? 'y' : 'ies'}`,
        },
  )
}

/**
 * Cmd-K's "File in a space…": asks for the space in the palette, files the
 * record there with `tagIntoSpace`, and stays open for another. (D70)
 * The list is the space picker's own `listSpaces`.
 */
export function fileInSpaceAction(record: {
  id: string
  name: string
  filedIds: ReadonlyArray<string>
}): PageAction {
  const filed = new Set(record.filedIds)
  return {
    id: 'file-in-space',
    label: 'File in a space…',
    icon: FolderInput,
    words: 'tag space file',
    step: {
      mode: 'File in',
      subject: record.name,
      placeholder: 'Find a space…',
      heading: 'Spaces',
      hint: `files ${record.name}, stays open for another`,
      choices: async () => spaceChoices(await listSpaces(), filed),
      pick: async (choice) => {
        try {
          await tagIntoSpace({
            data: { entityId: record.id, spaceId: choice.id },
          })
          filed.add(choice.id)
          toast(`Filed ${record.name} in ${choice.label}`)
          return { ...choice, meta: 'filed here', done: true }
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : 'Could not file it there',
          )
          throw err
        }
      },
    },
  }
}
