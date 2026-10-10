import { useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import { DetailsPickRow } from '#/components/record/details-add'
import { RailEmpty, RailSection } from '#/components/record/record-parts'
import { SpaceRailRow } from '#/components/record/space-rail-row'
import { SuggestSpacesAction } from '#/components/record/suggest-spaces'
import { tagIntoSpace, untagFromSpace } from '#/lib/server-fns'

/** How many spaces the add row offers for one search. */
const SHOWN = 8

/**
 * A record's Spaces section in its details column: the spaces it is filed
 * in, then `+ Add to a space…` and the classify lane's Suggest spaces. The
 * same two server fns on every record kind.
 */
export function RecordSpacesSection({
  entityId,
  spaces,
  allSpaces,
}: {
  entityId: string
  spaces: ReadonlyArray<{ id: string; name: string; archived: boolean }>
  allSpaces: ReadonlyArray<{ id: string; name: string }>
}) {
  const router = useRouter()
  const search = useCallback(
    (q: string) => {
      const term = q.toLowerCase()
      const filed = new Set(spaces.map((s) => s.id))
      return Promise.resolve(
        allSpaces
          .filter((s) => !filed.has(s.id))
          .filter((s) => s.name.toLowerCase().includes(term))
          .slice(0, SHOWN)
          .map((s) => ({ id: s.id, name: s.name })),
      )
    },
    [spaces, allSpaces],
  )
  return (
    <RailSection label="Spaces" meta={`${spaces.length}`}>
      {spaces.length === 0 ? <RailEmpty>Not filed.</RailEmpty> : null}
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
      <DetailsPickRow
        label="Add to a space…"
        placeholder="Space name…"
        search={search}
        onPick={async (hit) => {
          await tagIntoSpace({ data: { entityId, spaceId: hit.id } })
          void router.invalidate()
        }}
      />
      <SuggestSpacesAction entityId={entityId} />
    </RailSection>
  )
}
