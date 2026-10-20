import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import {
  entity,
  interaction,
  interactionEntity,
  link,
  note,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { ContextItem } from '@spaces/core/context/types'
import { noteSource } from '@spaces/core/writes/ai/chunk-sources'
import { assembleProgram } from '@spaces/core/writes/context/assemble'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import { completeMessage } from '#/lib/ai/complete'
import { inlineCitations } from '#/lib/ai/inline-citations'
import { excludeSensitiveProgram } from '#/lib/ai/route'
import { providerLabel, refusedLine, routeLine } from '#/lib/ai/route-line'
import type { SensitivityVia } from '#/lib/ai/sensitivity'
import { sensitivityFor } from '#/lib/ai/sensitivity-for'
import { SimilarLaneLive } from '#/lib/ai/similar'
import { openStreamProgram } from '#/lib/ai/stream'
import type { OpenedStream } from '#/lib/ai/stream'
import { citationLabels, sharedOnly } from '#/lib/ai/summarize'
import { writeUpTitle } from '#/lib/interactions/write-up'
import { noteBodyFromMarkdown } from '@spaces/core/notes/markdown-blocks'
import type { PrepEvent } from '#/lib/meetings/day'

/**
 * Prep: the assembler over a meeting's linked records, through the
 * synthesize lane, streamed into the meeting window on demand. (D68)
 * - Never stored. "Save as note" is a separate write of the text the reader
 *   was shown, filed `tagged_in` on the same records, the reader as author.
 * - The sensitivity gate is per call: any linked record that resolves
 *   sensitive makes the call sensitive, which routes local or refuses.
 * - Private notes stay out of the context: a saved brief is shared.
 */

/** The assembler's budget across every linked record. */
export const PREP_CONTEXT_CHARS = 24_000
/** The whole prompt, task included. */
export const PREP_BUDGET_CHARS = 60_000

export class PrepRefused extends Schema.TaggedError<PrepRefused>()(
  'PrepRefused',
  { message: Schema.String },
) {}

export class PrepQueryFailed extends Schema.TaggedError<PrepQueryFailed>()(
  'PrepQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PrepQueryFailed({ cause }),
  })

type Meeting = {
  id: string
  title: string
  startsAt: Date
  records: Array<{ id: string; name: string; kind: string }>
}

const meetingProgram = Effect.fn('prep.meeting')(function* (
  interactionId: string,
): Effect.fn.Return<Meeting, PrepRefused | PrepQueryFailed> {
  const row = (yield* query(() =>
    db
      .select({
        kind: interaction.kind,
        subject: interaction.subject,
        occurredAt: interaction.occurredAt,
      })
      .from(interaction)
      .where(eq(interaction.id, interactionId)),
  )).at(0)
  if (!row || row.kind !== 'meeting')
    return yield* new PrepRefused({ message: 'That meeting is gone' })
  const records = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(interactionEntity)
      .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
      .where(
        and(
          eq(interactionEntity.interactionId, interactionId),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(entity.canonicalName)),
  )
  return {
    id: interactionId,
    title: writeUpTitle('meeting', row.subject, row.occurredAt),
    startsAt: row.occurredAt,
    records,
  }
})

const TASK = (m: Meeting) =>
  [
    `Brief the reader for the meeting "${m.title}" at ${m.startsAt.toISOString()}, with ${m.records.map((r) => r.name).join(', ')}.`,
    'Use only what the context above states; never add a fact from elsewhere, and say plainly where the material is silent on something that matters.',
    'Write markdown: two lines on what the meeting is for, then `## ` sections with `- ` bullets — who they are, where things stand, what changed recently, and the questions worth asking.',
    'Cite every claim inline, right after it, with the bracketed ref of the context item it came from, exactly as written above — for example [note:<id>].',
    'Do not write a title line, and do not wrap the answer in a code fence.',
  ].join('\n')

export type PrepInput = {
  userId: string
  interactionId: string
  /** ISO 8601; defaults to now. */
  asOf?: string
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  abortSignal?: AbortSignal
}

type Prepared = {
  opened: OpenedStream
  items: Array<ContextItem>
  sensitive: boolean
  via: SensitivityVia | null
}

/** Everything before the first token: records, context, gate, route. */
export const preparePrepProgram = Effect.fn('preparePrep')(function* (
  input: PrepInput,
) {
  const meeting = yield* meetingProgram(input.interactionId)
  if (meeting.records.length === 0)
    return yield* new PrepRefused({
      message: 'Nothing to prep: no records are linked to this meeting',
    })
  const asOf = input.asOf ?? new Date().toISOString()
  const per = Math.max(
    4000,
    Math.floor(PREP_CONTEXT_CHARS / meeting.records.length),
  )
  // Per call: the first linked record that resolves sensitive decides —
  // read first, because its route decides whether a neighbour's sensitive
  // chunks may enter the context.
  let via: SensitivityVia | null = null
  let sensitive = false
  for (const r of meeting.records) {
    const read = yield* sensitivityFor(r.id)
    if (read.sensitivity === 'sensitive') {
      sensitive = true
      via = read.via
      break
    }
  }
  const excludeSensitive = yield* excludeSensitiveProgram(
    'synthesize',
    sensitive ? 'sensitive' : 'normal',
  )

  const seen = new Set<string>()
  const items: Array<ContextItem> = []
  for (const r of meeting.records) {
    const assembled = yield* assembleProgram(
      { entityId: r.id },
      { user: { id: input.userId }, asOf, budgetChars: per, excludeSensitive },
    ).pipe(
      Effect.provide(SimilarLaneLive),
      Effect.mapError((cause) => new PrepQueryFailed({ cause })),
    )
    for (const item of assembled.items) {
      if (seen.has(item.ref)) continue
      seen.add(item.ref)
      items.push(item)
    }
  }
  const shared = yield* sharedOnly(items).pipe(
    Effect.mapError((cause) => new PrepQueryFailed({ cause })),
  )

  const opened = yield* openStreamProgram('synthesize', shared, {
    caller: { type: 'user', id: input.userId },
    sensitivity: sensitive ? 'sensitive' : 'normal',
    ...(via === null ? {} : { via }),
    budgetChars: PREP_BUDGET_CHARS,
    task: TASK(meeting),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.abortSignal === undefined
      ? {}
      : { abortSignal: input.abortSignal }),
  })
  const prepared: Prepared = { opened, items: shared, sensitive, via }
  return prepared
})

/** A Prep run as events: route, text deltas, then the finished brief. */
export async function* prepEvents(input: PrepInput): AsyncGenerator<PrepEvent> {
  const ready = await Effect.runPromise(
    Effect.result(preparePrepProgram(input)),
  )
  if (ready._tag === 'Failure') {
    const f = ready.failure
    switch (f._tag) {
      case 'PrepRefused':
        yield { type: 'failed', message: f.message }
        return
      case 'SensitiveRouteRefused':
        yield { type: 'refused', line: refusedLine(completeMessage(f)) }
        return
      case 'PrepQueryFailed':
      case 'SensitivityReadFailed':
      case 'SensitivityEntityNotFound':
        yield {
          type: 'failed',
          message: 'Could not read the meeting’s records',
        }
        return
      default:
        yield { type: 'failed', message: completeMessage(f) }
        return
    }
  }
  const { opened, items, sensitive, via } = ready.success
  let text = ''
  // However this generator ends — drained, or returned by a cancelled
  // reader at any yield — the call's usage is recorded.
  try {
    yield {
      type: 'route',
      sensitive,
      line: routeLine(opened.target, via, sensitive),
    }
    try {
      for await (const part of opened.parts) {
        if (part.type !== 'text') continue
        text += part.text
        yield { type: 'text', text: part.text }
      }
    } catch {
      yield {
        type: 'failed',
        message: `${providerLabel(opened.target.provider)} did not answer`,
      }
      return
    }
  } finally {
    await opened.close()
  }
  const labels = await Effect.runPromise(
    citationLabels([...new Set(items.map((i) => i.ref))]).pipe(
      Effect.orElseSucceed(() => new Map<string, string>()),
    ),
  )
  yield {
    type: 'done',
    markdown: inlineCitations(text.trim(), labels).markdown,
  }
}

/**
 * `prepEvents` as the stream a server fn hands the browser. A cancel from the
 * reader aborts the provider call and ends the generator.
 */
export function prepStream(input: PrepInput): ReadableStream<PrepEvent> {
  const abort = new AbortController()
  const events = prepEvents({ ...input, abortSignal: abort.signal })
  return new ReadableStream<PrepEvent>({
    async pull(controller) {
      const next = await events.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      abort.abort()
      await events.return(undefined)
    },
  })
}

/**
 * "Save as note": the brief the reader was shown, written as one shared note
 * by the reader, filed `tagged_in` on every record linked to the meeting.
 * The markdown is rendered to blocks by the server's markdown renderer.
 */
export const savePrepNoteProgram = Effect.fn('savePrepNote')(function* (
  actorId: string,
  interactionId: string,
  markdown: string,
): Effect.fn.Return<{ noteId: string }, PrepRefused | PrepQueryFailed> {
  const meeting = yield* meetingProgram(interactionId)
  const first = meeting.records.at(0)
  if (!first)
    return yield* new PrepRefused({
      message: 'No records are linked to this meeting',
    })
  const title = `Prep: ${meeting.title}`.slice(0, 300)
  const body = noteBodyFromMarkdown(markdown)
  const noteId = yield* query(() =>
    db.transaction(async (tx) => {
      const ent = (
        await tx
          .insert(entity)
          .values({ kind: 'note', canonicalName: title, createdBy: actorId })
          .returning({ id: entity.id })
      ).at(0)
      if (!ent) throw new Error('note entity insert returned no row')
      await tx.insert(note).values({
        entityId: ent.id,
        authorId: actorId,
        title,
        kind: 'note',
        visibility: 'shared',
        bodyJson: body.bodyJson,
        bodyMd: body.bodyMd,
      })
      await tx.insert(link).values(
        meeting.records.map((r) => ({
          fromEntityId: ent.id,
          toEntityId: r.id,
          relation: 'tagged_in' as const,
          source: 'manual' as const,
          createdBy: actorId,
        })),
      )
      await tx.insert(activity).values({
        actorId,
        verb: 'note.created',
        subjectEntityId: first.id,
        objectEntityId: ent.id,
      })
      return ent.id
    }),
  )
  yield* Effect.promise(() => enqueueSourceEmbed(noteSource(noteId)))
  return { noteId }
})
