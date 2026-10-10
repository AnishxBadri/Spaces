import { z } from 'zod'
import { normalizeDomain } from '@spaces/sdk/identity'
import type {
  DiscoverClaim,
  DiscoveryEvidence,
  EntityId,
  JsonObject,
  SignalClaim,
  SpaceBrief,
  SpaceBriefMember,
} from '@spaces/sdk'

/** Exa's websets endpoint; the key travels in `x-api-key`, never the URL. */
export const EXA_WEBSETS_URL = 'https://api.exa.ai/websets/v0/websets'

/** Items asked for per page; the run's cap is applied as the items arrive. */
export const PAGE_SIZE = 50

/** Pages one run reads at most, whatever the cursors say. */
export const MAX_PAGES = 20

/** A webset by its id — or by its `externalId`, which Exa also accepts. */
export const websetUrl = (id: string): string =>
  `${EXA_WEBSETS_URL}/${encodeURIComponent(id)}`

/** One page of a webset's items, from `cursor` (null: the first page). */
export const itemsUrl = (websetId: string, cursor: string | null): string =>
  `${websetUrl(websetId)}/items?limit=${PAGE_SIZE}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`

/** What one watch holds, as its form takes it. */
export type WatchSettings = {
  /** What to look for; blank means the space's own criteria. */
  readonly criteria: string
  /** Companies handed on per run, at most. */
  readonly cap: number
}

/**
 * The cursor the job keeps in the watch's `state` — Exa's, none of the
 * host's.
 * - `cursor` is the page to read next; null is the first page.
 * - `lastItemId` is the last item handed on from that page, so a page read
 *   again skips what was already handed on and takes only what Exa added.
 */
export const watchState = z.object({
  websetId: z.string().min(1),
  cursor: z.string().min(1).nullable(),
  lastItemId: z.string().min(1).nullable(),
})
export type WatchState = z.output<typeof watchState>

/** The criteria the watch runs on: its own, else the space's, else none. */
export const criteriaOf = (
  settings: WatchSettings,
  brief: SpaceBrief,
): string | null => {
  const own = settings.criteria.trim()
  if (own !== '') return own
  const space = brief.space.criteria?.trim() ?? ''
  return space === '' ? null : space
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/** The memo nearest the subject: its own first, then up the path. */
const nearestMemo = (brief: SpaceBrief) => {
  const depth = new Map(brief.path.map((step, i) => [step.id, i]))
  return (
    [...brief.memos]
      .sort(
        (a, b) => (depth.get(b.spaceId) ?? -1) - (depth.get(a.spaceId) ?? -1),
      )
      .at(0) ?? null
  )
}

/** Exemplar domains Exa is told to find more of. */
export const MAX_EXEMPLARS = 10

/**
 * The webset query: what to look for (the criteria, else the space's path),
 * the thesis from the nearest memo, and the members as exemplars by domain.
 */
export const websetQuery = (
  brief: SpaceBrief,
  criteria: string | null,
): string => {
  const memo = nearestMemo(brief)
  const exemplars = [
    ...new Set(brief.members.flatMap((m) => m.domains.slice(0, 1))),
  ].slice(0, MAX_EXEMPLARS)
  return [
    criteria === null
      ? `Companies that belong in ${brief.path.map((s) => s.name).join(' › ')}`
      : `Companies matching: ${clip(criteria, 600)}`,
    memo === null
      ? null
      : `Thesis — ${clip(memo.title, 120)}: ${clip(memo.body, 400)}`,
    exemplars.length === 0 ? null : `Similar to: ${exemplars.join(', ')}`,
  ]
    .filter((part) => part !== null)
    .join('\n')
}

/**
 * The create request: a company search the size of one run's cap, with the
 * criteria Exa checks each result against, named by the watch so a second
 * create for the same watch is refused rather than paid for twice.
 */
export const createBody = (
  brief: SpaceBrief,
  settings: WatchSettings,
  watchId: string,
): JsonObject => {
  const criteria = criteriaOf(settings, brief)
  return {
    search: {
      query: websetQuery(brief, criteria),
      count: settings.cap,
      entity: { type: 'company' },
      ...(criteria === null ? {} : { criteria: [{ description: criteria }] }),
    },
    externalId: watchId,
  }
}

/** Exa's webset — the field this plugin reads. */
const webset = z.object({ id: z.string().min(1) })

export const websetId = (raw: unknown): string => webset.parse(raw).id

const reference = z.object({
  url: z.string().min(1),
  title: z.string().min(1).nullish(),
})

/**
 * One webset item — the fields this plugin reads. Parsed, never trusted: an
 * absent or null field is simply not claimed.
 */
const websetItem = z.object({
  id: z.string().min(1),
  properties: z.object({
    url: z.string().min(1),
    description: z.string().nullish(),
    company: z.object({ name: z.string().min(1).nullish() }).nullish(),
  }),
  evaluations: z
    .array(
      z.object({
        criterion: z.string().nullish(),
        satisfied: z.string().nullish(),
        references: z.array(reference).nullish(),
      }),
    )
    .nullish(),
})
export type Item = z.output<typeof websetItem>

const itemsPage = z.object({
  data: z.array(websetItem),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).nullish(),
})
export type ItemsPage = z.output<typeof itemsPage>

export const readPage = (raw: unknown): ItemsPage => itemsPage.parse(raw)

/** The page's items after `lastItemId`; all of them when it is not there. */
export const itemsAfter = (
  items: ReadonlyArray<Item>,
  lastItemId: string | null,
): ReadonlyArray<Item> => {
  const at =
    lastItemId === null ? -1 : items.findIndex((i) => i.id === lastItemId)
  return items.slice(at + 1)
}

/** The item's company name, else its domain. */
const nameOf = (item: Item, domain: string): string =>
  item.properties.company?.name ?? domain

/** The item's page, then every page Exa cited for a criterion, once each. */
export const evidenceOf = (item: Item): ReadonlyArray<DiscoveryEvidence> => {
  const seen = new Set<string>()
  const pages: Array<DiscoveryEvidence> = []
  const add = (url: string, title: string | null | undefined) => {
    if (seen.has(url)) return
    seen.add(url)
    pages.push(title == null ? { url } : { url, title })
  }
  add(item.properties.url, item.properties.company?.name)
  for (const evaluation of item.evaluations ?? [])
    for (const ref of evaluation.references ?? []) add(ref.url, ref.title)
  return pages
}

/** What one item becomes: a signal on a member, or a candidate. */
export type Hand =
  | { readonly _tag: 'skip' }
  | { readonly _tag: 'signal'; readonly claim: SignalClaim }
  | { readonly _tag: 'candidate'; readonly claim: DiscoverClaim }

/** The members by every domain they hold. */
export const membersByDomain = (
  members: ReadonlyArray<SpaceBriefMember>,
): ReadonlyMap<string, SpaceBriefMember> =>
  new Map(
    members.flatMap((m) =>
      m.domains.map((d) => [normalizeDomain(d) ?? d, m] as const),
    ),
  )

/**
 * One item → what it becomes.
 * - No registrable domain: skipped — nothing to resolve it by.
 * - A member's domain: one web signal on the member, keyed on the item's
 *   URL so a re-run writes nothing new, citing the page's receipt.
 * - Anything else: a candidate for the space, its pages as evidence.
 */
export const handOf = (
  item: Item,
  spaceId: EntityId,
  members: ReadonlyMap<string, SpaceBriefMember>,
  context: { readonly websetId: string; readonly receiptId: string },
): Hand => {
  const domain = normalizeDomain(item.properties.url)
  if (domain === null) return { _tag: 'skip' }
  const evidence = evidenceOf(item)
  const member = members.get(domain)
  if (member !== undefined) {
    const description = item.properties.description?.trim() ?? ''
    return {
      _tag: 'signal',
      claim: {
        _tag: 'signal',
        entityId: member.entityId,
        kind: 'web',
        key: `web:${item.properties.url}`,
        url: item.properties.url,
        title:
          description === ''
            ? `${member.name} found by an Exa watch`
            : clip(description, 200),
        receiptId: context.receiptId,
        payload: {
          websetId: context.websetId,
          exaItemId: item.id,
          evidence: evidence.map((e) =>
            e.title === undefined
              ? { url: e.url }
              : { url: e.url, title: e.title },
          ),
        },
      },
    }
  }
  return {
    _tag: 'candidate',
    claim: { spaceId, name: nameOf(item, domain), domain, evidence },
  }
}
