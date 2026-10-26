import { useRouter } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { PickPopover } from '#/components/record/details-add'
import { RailGroup } from '#/components/record/record-parts'
import { SpaceRailRow } from '#/components/record/space-rail-row'
import {
  SuggestSpacesRow,
  useSuggestSpaces,
} from '#/components/record/suggest-spaces'
import { spacePathLabel } from '#/lib/file-in-space'
import { tagIntoSpace, untagFromSpace } from '#/lib/server-fns'

/** How many spaces the popover offers for one search. */
const SHOWN = 8

/** A space the popover can offer: its path and how many companies it holds. */
type SpaceChoice = {
  id: string
  name: string
  parentId: string | null
  companies: number
}

/**
 * A record's Spaces group in its rail: the spaces it is filed in, and a `+`
 * whose popover searches `Add to a space…` by path, each with its mono
 * company count, ending on `✦ Suggest spaces` while the classify lane is
 * routed. The same two server fns on every record kind.
 */
export function RecordSpacesSection({
  entityId,
  spaces,
  allSpaces,
}: {
  entityId: string
  spaces: ReadonlyArray<{ id: string; name: string; archived: boolean }>
  allSpaces: ReadonlyArray<SpaceChoice>
}) {
  const router = useRouter()
  const suggest = useSuggestSpaces(entityId)
  const paths = useMemo(() => {
    const byId = new Map(allSpaces.map((s) => [s.id, s]))
    return new Map(allSpaces.map((s) => [s.id, spacePathLabel(s, byId)]))
  }, [allSpaces])
  const search = useCallback(
    (q: string) => {
      const term = q.toLowerCase()
      const filed = new Set(spaces.map((s) => s.id))
      return Promise.resolve(
        allSpaces
          .filter((s) => !filed.has(s.id))
          .map((s) => ({
            id: s.id,
            name: paths.get(s.id) ?? s.name,
            companies: s.companies,
          }))
          .filter((s) => s.name.toLowerCase().includes(term))
          .slice(0, SHOWN),
      )
    },
    [spaces, allSpaces, paths],
  )
  return (
    <RailGroup
      label="Spaces"
      count={spaces.length}
      empty={spaces.length === 0}
      add={(trigger) => (
        <PickPopover
          trigger={trigger}
          placeholder="Add to a space…"
          eager
          search={search}
          lane={(hit) => hit.companies}
          onPick={async (hit) => {
            await tagIntoSpace({ data: { entityId, spaceId: hit.id } })
            void router.invalidate()
          }}
          foot={
            suggest.routed
              ? (close) => (
                  <SuggestSpacesRow
                    running={suggest.running}
                    onPress={() => {
                      close()
                      void suggest.press()
                    }}
                  />
                )
              : undefined
          }
        />
      )}
    >
      {spaces.map((s) => (
        <SpaceRailRow
          key={s.id}
          space={s}
          onRemove={async () => {
            await untagFromSpace({ data: { entityId, spaceId: s.id } })
            void router.invalidate()
          }}
        />
      ))}
    </RailGroup>
  )
}
