import { effectFn } from '#/lib/server/effect'
import { withPictures } from '#/lib/records/pictures'
import { kindLanesProgram } from './kind-lanes'
import type { KindLane } from './kind-lanes'
import type { SearchHit } from './query'
import { searchAllHandler } from './search-all-handler'

/** A fused hit as Cmd-K draws it: its picture and its kind lane. */
export type PaletteHit = SearchHit & {
  picture: string | null
  lane: KindLane | null
}

/**
 * `searchAll`'s body for Cmd-K: the fused hits in the statement's own
 * name-first order, each entity with its picture and its kind lane. MCP has
 * no use for either, so `searchAllHandler` stays exactly what it answers.
 */
export async function paletteRecordsHandler(data: {
  q: string
}): Promise<Array<PaletteHit>> {
  const hits = await searchAllHandler(data)
  const lanes = await effectFn(kindLanesProgram)(
    hits.filter((h) => h.rowKind === 'entity').map((h) => h.id),
  )
  return withPictures(
    hits.map((h) => ({
      ...h,
      lane: h.rowKind === 'entity' ? (lanes.get(h.id) ?? null) : null,
    })),
  )
}
