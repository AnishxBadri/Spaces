import { z } from 'zod'
import type {
  AiItem,
  JsonObject,
  ReadEntity,
  Ref,
  SignalClaim,
} from '@spaces/sdk'

/** Exa's search endpoint; the key travels in `x-api-key`, never the URL. */
export const EXA_SEARCH_URL = 'https://api.exa.ai/search'

const DAY_MS = 86_400_000

/** What the job reads from its settings. */
export type ResearchSettings = {
  readonly maxResults: number
  readonly lookbackDays: number
}

/** The name, with the domain beside it to tell a common name apart. */
export const searchQuery = (record: ReadEntity): string => {
  const domain = record.keys.domain.at(0)
  return domain === undefined ? record.name : `${record.name} (${domain})`
}

/**
 * The search request: the record's name and domain, pages published within
 * the lookback, and Exa's highlights of each page as the brief's material.
 */
export const searchBody = (
  record: ReadEntity,
  settings: ResearchSettings,
  nowMs: number,
): JsonObject => ({
  query: searchQuery(record),
  type: 'auto',
  numResults: settings.maxResults,
  startPublishedDate: new Date(
    nowMs - settings.lookbackDays * DAY_MS,
  ).toISOString(),
  contents: { highlights: true },
})

/**
 * Exa's answer — the fields this plugin reads and nothing more. Parsed,
 * never trusted: an absent or null field is simply not claimed.
 */
const searchResponse = z.object({
  results: z.array(
    z.object({
      id: z.string().min(1).nullish(),
      url: z.string().min(1),
      title: z.string().min(1).nullish(),
      publishedDate: z.string().min(1).nullish(),
      author: z.string().min(1).nullish(),
      score: z.number().nullish(),
      highlights: z.array(z.string()).nullish(),
    }),
  ),
})

export type Hit = z.output<typeof searchResponse>['results'][number]

/** The hits, once per URL, in Exa's order. */
export const searchHits = (raw: unknown): ReadonlyArray<Hit> => {
  const seen = new Set<string>()
  return searchResponse.parse(raw).results.filter((hit) => {
    if (seen.has(hit.url)) return false
    seen.add(hit.url)
    return true
  })
}

/**
 * One hit → one web signal on the record, keyed on its URL so a second
 * research writes nothing new for a page already found.
 */
export const toSignal = (entityId: string, hit: Hit): SignalClaim => {
  const highlights = (hit.highlights ?? []).filter((h) => h.trim() !== '')
  return {
    _tag: 'signal',
    entityId,
    kind: 'web',
    key: `web:${hit.url}`,
    url: hit.url,
    ...(hit.title == null ? {} : { title: hit.title }),
    ...(hit.publishedDate == null ? {} : { publishedAt: hit.publishedDate }),
    payload: {
      ...(hit.id == null ? {} : { exaId: hit.id }),
      ...(hit.author == null ? {} : { author: hit.author }),
      ...(hit.score == null ? {} : { score: hit.score }),
      ...(highlights.length === 0 ? {} : { highlights }),
    },
  }
}

/** A hit's place-holding ref in the prompt, before its signal exists. */
export const hitRef = (index: number): Ref => `event:hit-${index + 1}`

/** The record and each hit, as the context the brief is drafted from. */
export const briefItems = (
  record: ReadEntity,
  hits: ReadonlyArray<Hit>,
): ReadonlyArray<AiItem> => [
  { ref: `attr:${record.id}:name`, text: record.name },
  ...hits.map((hit, index) => ({
    ref: hitRef(index),
    text: [
      [hit.title, hit.publishedDate?.slice(0, 10), hit.url]
        .filter((part) => part != null)
        .join(' — '),
      ...(hit.highlights ?? []),
    ].join('\n'),
  })),
]

/**
 * The draft with each place-holding ref swapped for the signal it became.
 * `signalRefs[i]` is hit i's ref; a placeholder past the end is left as the
 * model wrote it.
 */
export const citeSignals = (
  draft: string,
  signalRefs: ReadonlyArray<Ref>,
): string =>
  draft.replace(/event:hit-(\d+)/g, (whole, n: string) => {
    const index = Number(n) - 1
    return index < 0 ? whole : (signalRefs.at(index) ?? whole)
  })

const errorBody = z.object({ error: z.string().min(1) })

/** Exa's own sentence for a failed call, else the body as it came, trimmed. */
export const exaMessage = (body: string): string => {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    json = null
  }
  const parsed = errorBody.safeParse(json)
  if (parsed.success) return parsed.data.error
  const trimmed = body.trim()
  return trimmed === '' ? '(no message)' : trimmed.slice(0, 500)
}
