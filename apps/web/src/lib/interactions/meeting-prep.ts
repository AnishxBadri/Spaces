import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import {
  askThread,
  askTurn,
  entity,
  interaction,
  interactionEntity,
  link,
  note,
  objectDef,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { parseRef, ref } from '@spaces/core/context/ref'
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
import { meetingSheetProgram } from '#/lib/interactions/meeting-sheet-read'
import { noteBodyFromMarkdown } from '@spaces/core/notes/markdown-blocks'
import { citedRefs } from '#/lib/ask/answer'
import type { AskRef, AskScopeChip } from '#/lib/ask/types'
import { recordPath } from '#/lib/record-path'
import type { PrepEvent } from '#/lib/meetings/day'
import type { SheetPerson } from '#/lib/meetings/sheet'

/**
 * The brief: the assembler over a meeting's linked records and the meeting's
 * own guest list, through the synthesize lane, streamed into the meeting's
 * brief card on demand, in four cited parts (`parseBrief`).
 * - Never stored. "Save as note" is a separate write of the text the reader
 *   was shown, filed `tagged_in` on the same records, the reader as author;
 *   "Ask about this" opens it as a thread of the reader's.
 * - The sensitivity gate is per call: any linked record that resolves
 *   sensitive makes the call sensitive, which routes local or refuses.
 * - Private notes stay out of the context: a saved brief is shared.
 */

/** The assembler's budget across every linked record. */
export const PREP_CONTEXT_CHARS = 24_000
/** The whole request, system part and subject included. */
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

const INSTRUCTIONS = [
  'Brief the reader for the meeting the last line names.',
  'Use only what the context states; never add a fact from elsewhere, and say plainly where the material is silent on something that matters.',
  'Write exactly four parts, in this order, each on its own line that starts with its label and a colon, and nothing else:',
  'Who: who is coming, and who is new to us.',
  'Deal: where the deal stands.',
  'Last time: the last write-up’s point, and the tasks still open.',
  'Since: what has moved since then — emails, files, signals.',
  'Each part is one to three short plain sentences: no headings, bullets or bold.',
  'Cite every claim inline, right after it, with the bracketed ref of the context item it came from, exactly as written — for example [note:<id>].',
].join('\n')

const SUBJECT = (m: Meeting) =>
  `Brief the reader for the meeting "${m.title}" at ${m.startsAt.toISOString()}, with ${m.records.map((r) => r.name).join(', ')}.`

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
  /** The meeting's own ref and title: the guest list's citation. */
  self: { ref: string; title: string }
}

const RSVP_WORD: Record<SheetPerson['rsvp'], string | null> = {
  accepted: null,
  tentative: 'maybe',
  declined: 'declined',
  needs_action: 'no reply',
}

/** The guest list as an item, so `Who` cites the meeting it came from. */
function guestItem(
  meeting: Meeting,
  people: ReadonlyArray<SheetPerson>,
): ContextItem {
  const who = people.map((p) => {
    const marks = [
      p.you ? 'the reader' : null,
      p.host ? 'host' : null,
      p.new ? 'new to us' : null,
      RSVP_WORD[p.rsvp],
    ].filter((m) => m !== null)
    const line = p.line === null ? '' : ` (${p.line})`
    return `${p.name}${line}${marks.length === 0 ? '' : ` — ${marks.join(', ')}`}`
  })
  return {
    ref: ref.interaction(meeting.id),
    kind: 'interaction',
    text: `The meeting "${meeting.title}". Invited: ${who.length === 0 ? 'nobody is listed' : who.join('; ')}.`,
    entityIds: meeting.records.map((r) => r.id),
    at: meeting.startsAt.toISOString(),
  }
}

/**
 * The sources a run reads, as a person counts them: a record's attribute
 * values are one source, a document's pages are one, anything else is one.
 */
export function sourceCount(items: ReadonlyArray<ContextItem>): number {
  const keys = new Set(
    items.map((i) => {
      const p = parseRef(i.ref)
      return p?.kind === 'attr' || p?.kind === 'doc'
        ? `${p.kind}:${p.entityId}`
        : i.ref
    }),
  )
  return keys.size
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
  const sheet = yield* meetingSheetProgram(
    { id: input.userId },
    input.interactionId,
  ).pipe(Effect.mapError((cause) => new PrepQueryFailed({ cause })))
  shared.unshift(guestItem(meeting, sheet.people))

  const opened = yield* openStreamProgram('synthesize', shared, {
    caller: { type: 'user', id: input.userId },
    sensitivity: sensitive ? 'sensitive' : 'normal',
    ...(via === null ? {} : { via }),
    budgetChars: PREP_BUDGET_CHARS,
    instructions: INSTRUCTIONS,
    subject: SUBJECT(meeting),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.abortSignal === undefined
      ? {}
      : { abortSignal: input.abortSignal }),
  })
  const prepared: Prepared = {
    opened,
    items: shared,
    sensitive,
    via,
    self: { ref: ref.interaction(meeting.id), title: meeting.title },
  }
  return prepared
})

/**
 * The sources a brief cites, labelled and linked as Ask's are. `given` keeps
 * only what the model was handed; a ref with no label is dropped. The
 * meeting's own ref reads as its title.
 */
export const briefRefsProgram = Effect.fn('briefRefs')(function* (
  body: string,
  given: ReadonlySet<string> | null,
  self: { ref: string; title: string },
): Effect.fn.Return<Array<AskRef>, PrepQueryFailed> {
  const cited = citedRefs(body).filter(
    (r) => parseRef(r) !== null && (given === null || given.has(r)),
  )
  if (cited.length === 0) return []
  const labels = yield* citationLabels(cited).pipe(
    Effect.orElseSucceed(() => new Map<string, string>()),
  )
  labels.set(self.ref, self.title)
  const ids = [
    ...new Set(
      cited.flatMap((r) => {
        const p = parseRef(r)
        return p !== null && 'entityId' in p ? [p.entityId] : []
      }),
    ),
  ]
  const rows =
    ids.length === 0
      ? []
      : yield* query(() =>
          db
            .select({
              id: entity.id,
              kind: entity.kind,
              objectSlug: objectDef.slug,
            })
            .from(entity)
            .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
            .where(inArray(entity.id, ids)),
        )
  const byId = new Map(rows.map((r) => [r.id, r]))
  return cited.flatMap((r): Array<AskRef> => {
    const label = labels.get(r)
    if (label === undefined) return []
    const p = parseRef(r)
    const row = p !== null && 'entityId' in p ? byId.get(p.entityId) : undefined
    return [
      {
        ref: r,
        label,
        // A document chunk previews on hover; it has no page of its own.
        href: row === undefined || p?.kind === 'doc' ? null : recordPath(row),
        entityId: row?.id ?? null,
      },
    ]
  })
})

/** A brief run as events: route, text deltas, then the finished brief. */
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
  const { opened, items, sensitive, via, self } = ready.success
  let text = ''
  // However this generator ends — drained, or returned by a cancelled
  // reader at any yield — the call's usage is recorded.
  try {
    yield {
      type: 'route',
      sensitive,
      line: routeLine(opened.target, via, sensitive),
      sources: sourceCount(items),
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
  const body = text.trim()
  const refs = await Effect.runPromise(
    briefRefsProgram(body, new Set(items.map((i) => i.ref)), self).pipe(
      Effect.orElseSucceed((): Array<AskRef> => []),
    ),
  )
  yield {
    type: 'done',
    body,
    refs,
    markdown: inlineCitations(body, new Map(refs.map((r) => [r.ref, r.label])))
      .markdown,
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

/** The scope a brief's thread asks in: the meeting's records, as chips. */
const recordChip = (r: Meeting['records'][number]): AskScopeChip => ({
  kind: r.kind === 'person' ? 'person' : 'record',
  id: r.id,
  name: r.name,
  href: recordPath(r),
})

/**
 * "Ask about this": a new thread of the reader's that opens on the brief,
 * the reader's ask and the brief as its answer, both scoped to the
 * meeting's records, so the next question reads the brief as history and
 * passes the same sensitivity gate. The refs are read again from the body:
 * only sources that still resolve are kept.
 */
export const briefThreadProgram = Effect.fn('briefThread')(function* (
  userId: string,
  interactionId: string,
  body: string,
  route: string | null,
): Effect.fn.Return<
  { threadId: string; scope: ReadonlyArray<AskScopeChip> },
  PrepRefused | PrepQueryFailed
> {
  const meeting = yield* meetingProgram(interactionId)
  const refs = yield* briefRefsProgram(body, null, {
    ref: ref.interaction(meeting.id),
    title: meeting.title,
  })
  const scope = meeting.records.map(recordChip)
  const question = `Brief me for ${meeting.title}`
  const threadId = yield* query(() =>
    db.transaction(async (tx) => {
      const thread = (
        await tx
          .insert(askThread)
          .values({ userId, title: `Brief: ${meeting.title}`.slice(0, 200) })
          .returning({ id: askThread.id })
      ).at(0)
      if (!thread) throw new Error('ask_thread insert returned no row')
      await tx.insert(askTurn).values([
        { threadId: thread.id, role: 'user', bodyMd: question, scope },
        {
          threadId: thread.id,
          role: 'assistant',
          bodyMd: body,
          refs,
          scope,
          state: 'answered',
          route,
        },
      ])
      return thread.id
    }),
  )
  return { threadId, scope }
})
