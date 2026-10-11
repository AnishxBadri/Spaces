import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import type { Json } from '@spaces/db/json'
import { JobRetryable, Receipts } from '@spaces/sdk'
import type { JobError } from '@spaces/sdk'
import type { ResolvedSensitivity } from '../../ai/sensitivity'
import { CORE_IDENTITY } from '../../attributes/registry'
import { EnrichmentCollector } from '../../enrichment/collector'
import type { AskInput, AskResult, SkipNote } from '../../enrichment/sources'
import {
  MODEL_KEYS,
  WEBSITE_KEYS,
  WEBSITE_MODEL_NAME,
  WEBSITE_SCHEMA,
  WEBSITE_SENSITIVE,
  WEBSITE_TASK,
  WebsiteReader,
  aboutLinkOf,
  decodePage,
  isHtml,
  markupAnswers,
  pageItems,
  readPage,
  websiteAnswers,
  websiteLabel,
  websiteOutput,
} from '../../enrichment/website'
import type { Page, WebsiteOutput } from '../../enrichment/website'
import { ModelCall, subjectSensitivity } from '../ports/ai'
import { ReceiptsLive } from '../ports/receipts'
import { enrichmentRow } from './apply'

/**
 * The built-in Website source (D76, D80): the company's home page read in
 * two halves, then answered as one.
 * - The markup half always runs and needs no model: no `ai_usage` row.
 * - The model half reads the home page and its about page with the owner's
 *   Extract lane, only when a route exists, for the keys the markup half
 *   left empty; its call is `ai_usage` on the host's `core.enrichment` row.
 * - No key and no credit: the receipt records 0 credits.
 * - A sensitive record's model half reads only through a local route;
 *   otherwise it is skipped and the run's timeline line says so.
 * - A failed fetch ends this source with its reason; the run goes on.
 */

/** The prompt ceiling: the Extract lane's, as `AiLive` gives it. */
const BUDGET_CHARS = 48_000

/** Whether the model half reads: routed, no route at all, or refused by the record's sensitivity. */
export type WebsiteModel = 'routed' | 'unrouted' | 'blocked'

/** The source as a run holds it: its row, the record's sensitivity, whether the model half may read. */
export type WebsitePlan = {
  readonly row: { readonly id: string; readonly capabilityId: string }
  readonly sensitivity: ResolvedSensitivity
  readonly model: WebsiteModel
}

const declined = (reason: string): AskResult => ({ asked: false, reason })

const SENSITIVE_NOTE: SkipNote = {
  name: WEBSITE_MODEL_NAME,
  why: WEBSITE_SENSITIVE,
}

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * The Website for this record, or null when it is not a company. It is in
 * the order with or without a model (D80); the plan says whether the model
 * half may read.
 */
export const websiteFor = Effect.fn('websiteFor')(function* (
  kind: 'company' | 'person',
  entityId: string,
): Effect.fn.Return<WebsitePlan | null, JobError, WebsiteReader> {
  if (kind !== 'company') return null
  const reader = yield* WebsiteReader
  const sensitivity = yield* subjectSensitivity(entityId)
  const route = yield* reader.extractRoute(sensitivity.sensitivity)
  const model: WebsiteModel =
    sensitivity.sensitivity === 'normal'
      ? route === 'unrouted'
        ? 'unrouted'
        : 'routed'
      : route === 'local'
        ? 'routed'
        : route === 'unrouted' &&
            (yield* reader.extractRoute('normal')) === 'unrouted'
          ? 'unrouted'
          : 'blocked'
  const row = yield* Effect.tryPromise({
    try: enrichmentRow,
    catch: (cause) =>
      new JobRetryable({ reason: `Website: ${messageOf(cause)}` }),
  })
  return { row, sensitivity, model }
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

/** What the model half did: answered, skipped with a note, or failed with its reason. */
type ModelHalf =
  | {
      readonly ran: true
      readonly pages: ReadonlyArray<Page>
      readonly extracted: WebsiteOutput
      readonly answers: { [key: string]: Json }
    }
  | {
      readonly ran: false
      readonly reason: string
      readonly note?: SkipNote
      /** The call was made and failed, as opposed to never made. */
      readonly failed?: true
    }

/** The model half: the home and about pages through the Extract lane, for `keys`. */
const readWithModel = Effect.fn('website.model')(function* (
  plan: WebsitePlan,
  home: Page,
  keys: ReadonlyArray<string>,
): Effect.fn.Return<ModelHalf, JobError, WebsiteReader | ModelCall> {
  if (plan.model === 'blocked')
    return {
      ran: false,
      reason: 'a sensitive record reads only through a local Extract route',
      note: SENSITIVE_NOTE,
    }
  if (plan.model === 'unrouted')
    return { ran: false, reason: 'no model reads the Extract lane' }
  if (keys.length === 0)
    return { ran: false, reason: 'the markup answered every key' }
  const pages: Array<Page> = [home]
  const about = aboutLinkOf(home)
  if (about !== null) {
    const page = yield* fetchPage(about)
    if (typeof page !== 'string') pages.push(page)
  }
  const called = yield* (yield* ModelCall)
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
      ? {
          ran: false,
          reason: called.refused.message,
          note: SENSITIVE_NOTE,
        }
      : {
          ran: false,
          reason: `${called.refused.tag}: ${called.refused.message}`,
          failed: true,
        }
  const output = websiteOutput.safeParse(
    called.output.kind === 'object'
      ? called.output.object
      : parsedText(called.output.text),
  )
  if (!output.success)
    return {
      ran: false,
      reason: 'the Extract lane answered outside the schema',
      failed: true,
    }
  return {
    ran: true,
    pages,
    extracted: output.data,
    answers: websiteAnswers(output.data, pages, keys),
  }
})

/**
 * Ask the Website within a run: the markup half, then the model half for
 * what it left empty. The answers go to the run's collector as one, under
 * one receipt, and the result names which halves ran.
 */
export const askWebsite = Effect.fn('askWebsite')(function* (
  plan: WebsitePlan,
  input: AskInput,
): Effect.fn.Return<AskResult, JobError, WebsiteReader | ModelCall> {
  const keys = input.keys.filter((k) => WEBSITE_KEYS.some((w) => w === k))
  if (keys.length === 0) return declined('nothing it reads is wanted')
  const domain = yield* domainOf(input.entityId)
  if (domain === null) return declined('no domain to read')

  const home = yield* fetchPage(`https://${domain}/`)
  if (typeof home === 'string') return declined(home)
  const markup = markupAnswers(home, keys)
  const left = keys.filter(
    (k) => !(k in markup) && MODEL_KEYS.some((m) => m === k),
  )
  const model = yield* readWithModel(plan, home, left)
  // Neither half answered and the call failed: the source ends with its reason.
  if (!model.ran && model.failed === true && Object.keys(markup).length === 0)
    return declined(model.reason)
  const answers = model.ran ? { ...model.answers, ...markup } : markup

  const { receiptId } = yield* Effect.gen(function* () {
    return yield* (yield* Receipts).store({
      entityId: input.entityId,
      raw: {
        source: 'website',
        pages: model.ran ? model.pages.map((p) => p.url) : [home.url],
        title: home.title,
        markup,
        model: model.ran
          ? { extracted: model.extracted, answers: model.answers }
          : { skipped: model.reason },
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
  const note = model.ran ? undefined : model.note
  const asked: AskResult = {
    asked: true,
    name: websiteLabel(model.ran),
    ...(note === undefined ? {} : { notes: [note] }),
  }
  return asked
})
