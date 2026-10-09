import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { JobRetryable, Receipts } from '@spaces/sdk'
import type { JobError } from '@spaces/sdk'
import type { ResolvedSensitivity } from '../../ai/sensitivity'
import { CORE_IDENTITY } from '../../attributes/registry'
import { EnrichmentCollector } from '../../enrichment/collector'
import type { AskInput, AskResult } from '../../enrichment/sources'
import {
  WEBSITE_KEYS,
  WEBSITE_SCHEMA,
  WEBSITE_SENSITIVE,
  WEBSITE_TASK,
  WebsiteReader,
  aboutLinkOf,
  decodePage,
  isHtml,
  pageItems,
  readPage,
  websiteAnswers,
  websiteOutput,
} from '../../enrichment/website'
import type { Page } from '../../enrichment/website'
import { ModelCall, subjectSensitivity } from '../ports/ai'
import { ReceiptsLive } from '../ports/receipts'
import { enrichmentRow } from './apply'

/**
 * The built-in Website source (D76): the company's home page, and its about
 * page when the home page links one, read by the owner's Extract lane.
 * - No key and no credit: its receipt records 0 credits, and the model call
 *   is `ai_usage` on the host's `core.enrichment` row, lane `extract`.
 * - A sensitive record reads only through a local route; otherwise the
 *   source is skipped and the run's timeline line says so.
 * - With no Extract route at all the source is not in the order (D80).
 * - A failed fetch or call ends this source with its reason; the run goes on.
 */

/** The prompt ceiling: the Extract lane's, as `AiLive` gives it. */
const BUDGET_CHARS = 48_000

/** The source as a run holds it: its row, the record's sensitivity, whether it may read. */
export type WebsitePlan = {
  readonly row: { readonly id: string; readonly capabilityId: string }
  readonly sensitivity: ResolvedSensitivity
  /** A sensitive record with no local Extract route: in the order, skipped. */
  readonly blocked: boolean
}

const declined = (reason: string): AskResult => ({ asked: false, reason })

const SENSITIVE: AskResult = {
  asked: false,
  reason: 'a sensitive record reads only through a local Extract route',
  line: WEBSITE_SENSITIVE,
}

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * The Website for this record, or null when it is not in the order: not a
 * company, or no Extract route the record could use or be refused by.
 */
export const websiteFor = Effect.fn('websiteFor')(function* (
  kind: 'company' | 'person',
  entityId: string,
): Effect.fn.Return<WebsitePlan | null, JobError, WebsiteReader> {
  if (kind !== 'company') return null
  const reader = yield* WebsiteReader
  const sensitivity = yield* subjectSensitivity(entityId)
  const route = yield* reader.extractRoute(sensitivity.sensitivity)
  let blocked = false
  if (sensitivity.sensitivity === 'normal') {
    if (route === 'unrouted') return null
  } else if (route !== 'local') {
    if (
      route === 'unrouted' &&
      (yield* reader.extractRoute('normal')) === 'unrouted'
    )
      return null
    blocked = true
  }
  const row = yield* Effect.tryPromise({
    try: enrichmentRow,
    catch: (cause) =>
      new JobRetryable({ reason: `Website: ${messageOf(cause)}` }),
  })
  return { row, sensitivity, blocked }
})

/** The record's first domain, bare. */
const domainOf = (entityId: string) =>
  Effect.tryPromise({
    try: async () => {
      const row = (
        await db
          .select({ values: entity.values })
          .from(entity)
          .where(eq(entity.id, entityId))
      ).at(0)
      const held = row?.values[CORE_IDENTITY.company.slug]
      const first = Array.isArray(held)
        ? held.find((v) => typeof v === 'string')
        : held
      if (typeof first !== 'string') return null
      const bare = first
        .trim()
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
      return bare === '' ? null : bare
    },
    catch: (cause) =>
      new JobRetryable({ reason: `Website: ${messageOf(cause)}` }),
  })

/** One page read, or the sentence saying why it could not be. */
const fetchPage = Effect.fn('website.fetchPage')(function* (url: string) {
  const fetched = yield* (yield* WebsiteReader).fetch(url)
  if (!fetched.ok) return fetched.reason
  const body = decodePage(fetched.bytes)
  if (!isHtml(fetched.contentType, body))
    return `${fetched.url} is not an HTML page`
  const page: Page = readPage(body, fetched.url)
  return page
})

const parsedText = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Ask the Website within a run: its answers go to the run's collector. */
export const askWebsite = Effect.fn('askWebsite')(function* (
  plan: WebsitePlan,
  input: AskInput,
): Effect.fn.Return<AskResult, JobError, WebsiteReader | ModelCall> {
  if (plan.blocked) return SENSITIVE
  const keys = input.keys.filter((k) => WEBSITE_KEYS.some((w) => w === k))
  if (keys.length === 0) return declined('nothing it reads is wanted')
  const domain = yield* domainOf(input.entityId)
  if (domain === null) return declined('no domain to read')

  const home = yield* fetchPage(`https://${domain}/`)
  if (typeof home === 'string') return declined(home)
  const pages: Array<Page> = [home]
  const about = aboutLinkOf(home)
  if (about !== null) {
    const page = yield* fetchPage(about)
    if (typeof page !== 'string') pages.push(page)
  }

  const model = yield* ModelCall
  const called = yield* model
    .complete({
      lane: 'extract',
      items: pageItems(pages),
      schema: WEBSITE_SCHEMA,
      task: WEBSITE_TASK,
      budgetChars: BUDGET_CHARS,
      caller: { type: 'integration', id: plan.row.id },
      sensitivity: plan.sensitivity,
    })
    .pipe(
      Effect.map((output) => ({ output })),
      Effect.catch((refused) => Effect.succeed({ refused })),
    )
  if ('refused' in called)
    return called.refused.tag === 'SensitiveRouteRefused'
      ? SENSITIVE
      : declined(`${called.refused.tag}: ${called.refused.message}`)
  const output = websiteOutput.safeParse(
    called.output.kind === 'object'
      ? called.output.object
      : parsedText(called.output.text),
  )
  if (!output.success)
    return declined('the Extract lane answered outside the schema')

  const answers = websiteAnswers(output.data, pages, keys)
  const { receiptId } = yield* Effect.gen(function* () {
    return yield* (yield* Receipts).store({
      entityId: input.entityId,
      raw: {
        source: 'website',
        pages: pages.map((p) => p.url),
        extracted: output.data,
        answers,
      },
      creditsUsed: 0,
    })
  }).pipe(Effect.provide(ReceiptsLive(plan.row)))

  const collector = yield* EnrichmentCollector
  if (
    collector !== null &&
    collector.integrationId === plan.row.id &&
    collector.entityId === input.entityId &&
    Object.keys(answers).length > 0
  )
    collector.answers.push({
      receiptId,
      asOf: new Date().toISOString(),
      answers,
    })
  const asked: AskResult = { asked: true }
  return asked
})
