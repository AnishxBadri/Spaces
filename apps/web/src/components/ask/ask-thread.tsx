import { Link } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import {
  askQuestion,
  getAskThread,
  saveAskAnswerAsNote,
} from '#/lib/server-fns'
import type {
  AskCall,
  AskCardView,
  AskEvent,
  AskScopeChip,
  AskThreadView,
  AskTurnView,
} from '#/lib/server-fns'
import { SCOPE_DROPPED } from '#/lib/ask/scope'
import { scopeKey, scopeWords } from '#/lib/ask/types'
import {
  CALL_WORD,
  modelLine,
  shownCalls,
  stoppedWords,
  thinkingWords,
  turnNotice,
} from '#/lib/ask/notice'
import type { AskNotice } from '#/lib/ask/notice'
import { chipKey, chipLabel } from '#/lib/ask/page-scope'
import { dayKey, formatTime, formatWeekday } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { Twinkle } from '#/components/twinkle'
import { cn } from '#/lib/utils'
import { AskAnswer, RefChip } from './ask-answer'
import { PluginMark } from '#/components/integrations/integration-ledger'
import { AskCards } from './ask-card'
import { Divider } from './divider'
import { FindTable } from './find-table'
import { MentionTextarea } from './mention-popover'
import type { AnswerVariant } from './ask-answer'

/**
 * One Ask thread, shared by the dock and `/ask`: the turns as stored, the
 * turn streaming now, and the composer.
 * - Your turn is a bone block with a hairline, right-aligned, at most three
 *   quarters of the column, its time under it; the answer has no box.
 * - A scope change between questions is a centred mono divider.
 * - The turn streaming now carries its Twinkle and Stop; the composer has
 *   no Send, only ⌘↵.
 */

/** The answer streaming now, before it is stored. */
export type LiveTurn = {
  question: AskTurnView
  answerId: string | null
  route: string | null
  text: string
  calls: ReadonlyArray<{ id: string; call: AskCall }>
  /** Cards proposed so far; stored, with their verbs, when the turn ends. */
  cards: ReadonlyArray<AskCardView>
  /** `lost`: the stream broke without a Stop; `stopped`: the reader stopped it. */
  phase: 'streaming' | 'lost' | 'stopped'
}

/** One event applied to the live turn. */
export function applyAskEvent(live: LiveTurn, event: AskEvent): LiveTurn {
  switch (event.type) {
    case 'turn':
      return { ...live, question: event.question, answerId: event.answerId }
    case 'route':
      // A new attempt: text and cards from the one before are dropped.
      return { ...live, route: event.line, text: '', cards: [] }
    case 'card':
      return {
        ...live,
        cards: [
          ...live.cards.filter((c) => c.id !== event.card.id),
          event.card,
        ],
      }
    case 'call': {
      const rest = live.calls.filter((c) => c.id !== event.id)
      const at = live.calls.findIndex((c) => c.id === event.id)
      const next = { id: event.id, call: event.call }
      return {
        ...live,
        calls:
          at < 0
            ? [...live.calls, next]
            : [...rest.slice(0, at), next, ...rest.slice(at)],
      }
    }
    case 'text':
      return { ...live, text: live.text + event.text }
    case 'end':
      return live
  }
}

/** Your question: bone, a hairline, right-aligned, its time under it. */
export function QuestionTurn({ turn }: { turn: AskTurnView }) {
  return (
    <div data-turn="user" className="flex flex-col items-end gap-1">
      <div className="max-w-3/4 border border-hairline bg-bone px-3 py-2 text-body whitespace-pre-wrap">
        {turn.body}
      </div>
      <span className="mono text-micro text-graphite">
        {formatTime(turn.createdAt)}
      </span>
    </div>
  )
}

/**
 * A notice over a turn: bone on a rule, a 6px warning or destructive
 * square, one sentence and at most one link.
 */
export function NoticeRow({ notice }: { notice: AskNotice }) {
  return (
    <div
      data-notice={notice.tone}
      className="flex min-h-8 items-center gap-2.5 border border-rule bg-bone px-3 py-1.5 text-ui"
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0',
          notice.tone === 'warning' ? 'bg-warning' : 'bg-destructive',
        )}
      />
      <span className="min-w-0 flex-1">{notice.sentence}</span>
      {notice.link === null ? null : (
        <Link
          to={notice.link.to}
          className="focus-ring shrink-0 text-label text-foreground hover:underline"
        >
          {notice.link.label}
        </Link>
      )}
    </div>
  )
}

/** A chip the turn could not resolve: a scope line naming it. */
function DroppedChips({ calls }: { calls: ReadonlyArray<AskCall> }) {
  return calls
    .filter((c) => c.tool === SCOPE_DROPPED)
    .map((c, i) => <Divider key={i}>Scope · {c.reason ?? c.input}</Divider>)
}

/** The tools a turn called, each with what it asked and found. */
export function CallStrip({ calls: all }: { calls: ReadonlyArray<AskCall> }) {
  const calls = shownCalls(all)
  if (calls.length === 0) return null
  return (
    <ul
      aria-label="Tools called"
      className="flex flex-wrap gap-x-3 gap-y-1 mono text-micro text-graphite"
    >
      {calls.map((c, i) => (
        <li key={i} className="flex items-center gap-1.5" title={c.reason}>
          {c.via === undefined ? null : (
            <span
              className="flex items-center gap-1"
              title={`via ${c.via.name}`}
            >
              <PluginMark name={c.via.name} />
              <span className="sr-only">{c.via.name}</span>
            </span>
          )}
          <span className="text-foreground">{c.tool}</span>
          {c.input === '' ? null : (
            <span className="max-w-40 truncate">{c.input}</span>
          )}
          {c.found === null ? null : <span>· {c.found}</span>}
          {CALL_WORD[c.state] === '' ? null : (
            <span>· {CALL_WORD[c.state]}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The find tables a turn's calls left, each drawn as its own table. */
function FindTables({
  calls,
  turnId,
  question,
  variant,
  threadId,
  line,
}: {
  calls: ReadonlyArray<AskCall>
  turnId: string | null
  question: string | null
  variant: AnswerVariant
  threadId: string | null
  /** The route and its time, over each table. */
  line: string | null
}) {
  return calls.flatMap((c, i) =>
    c.find === undefined || c.find.rows.length + c.find.hidden === 0
      ? []
      : [
          <FindTable
            key={i}
            table={c.find}
            turnId={turnId}
            callIndex={i}
            question={question}
            variant={variant}
            threadId={threadId}
            line={line}
          />,
        ],
  )
}

/** The answer's foot: `Provider · model`, then its sources. */
function AnswerFoot({ turn }: { turn: AskTurnView }) {
  const [open, setOpen] = useState(false)
  const model = modelLine(turn.route)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 mono text-micro text-graphite">
        {model === null ? null : <span>{model}</span>}
        {turn.refs.length === 0 ? null : (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="focus-ring hover:text-foreground"
          >
            Sources {turn.refs.length} ›
          </button>
        )}
      </div>
      {open ? (
        <ul className="flex flex-col border-t border-rule">
          {turn.refs.map((r) => (
            <li
              key={r.ref}
              className="flex h-7 items-center gap-3 border-b border-rule"
            >
              <span className="w-12 shrink-0 mono text-micro text-graphite">
                {r.ref.slice(0, r.ref.indexOf(':'))}
              </span>
              <RefChip source={r} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** A stored answer, in whatever state it ended. */
export function AnswerTurn({
  turn,
  variant,
  threadId,
  onRetry,
  waiting = false,
  question = null,
}: {
  turn: AskTurnView
  variant: AnswerVariant
  threadId: string | null
  onRetry?: (() => void) | undefined
  /** Not the latest answer: its undecided cards wait in Review. */
  waiting?: boolean
  /** The question this answers. */
  question?: string | null
}) {
  if (turn.hidden)
    return (
      <p data-turn="assistant" className="mono text-micro text-graphite">
        An answer here cited something you can no longer see
      </p>
    )
  const body =
    turn.body === '' ? null : (
      <AskAnswer
        body={turn.body}
        refs={turn.refs}
        variant={variant}
        threadId={threadId}
      />
    )
  const notice = turnNotice(turn.state, turn.route)
  const model = modelLine(turn.route)
  return (
    <div data-turn="assistant" className="flex flex-col gap-2.5">
      <DroppedChips calls={turn.calls} />
      {notice === null ? null : <NoticeRow notice={notice} />}
      {turn.state === 'no_provider' ? (
        <p className="text-body">
          Ask needs a model to answer.{' '}
          <Link
            to="/settings/models"
            className="focus-ring text-foreground underline underline-offset-2"
          >
            Add a model ›
          </Link>
        </p>
      ) : turn.state === 'empty' ? (
        <div className="flex flex-col gap-1">
          <p className="text-body">Nothing found.</p>
        </div>
      ) : turn.state === 'refused' || turn.state === 'capped' ? (
        body
      ) : turn.state === 'failed' ? (
        <>
          {body}
          <p className="text-body text-graphite">{turn.route}</p>
          {onRetry ? (
            <div>
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Retry
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        body
      )}
      <FindTables
        calls={turn.calls}
        turnId={turn.id}
        question={question}
        variant={variant}
        threadId={threadId}
        line={[model, formatTime(turn.createdAt)]
          .filter((p) => p !== null && p !== '')
          .join(' · ')}
      />
      <AskCards cards={turn.cards} waiting={waiting} />
      {turn.state === 'stopped' ? (
        <span data-stopped className="mono text-micro text-graphite">
          {stoppedWords(turn.calls)}
        </span>
      ) : null}
      <CallStrip calls={turn.calls} />
      {turn.state === 'answered' ||
      turn.state === 'stopped' ||
      turn.state === 'empty' ? (
        <AnswerFoot turn={turn} />
      ) : null}
    </div>
  )
}

/**
 * The answer arriving now: before its text, a Twinkle and what it is doing;
 * Stop, an outline button at the turn's right, while it streams.
 */
export function LiveAnswer({
  live,
  variant,
  threadId,
  onRetry,
  onStop,
}: {
  live: LiveTurn
  variant: AnswerVariant
  threadId: string | null
  onRetry: () => void
  onStop: () => void
}) {
  const calls = live.calls.map((c) => c.call)
  const streaming = live.phase === 'streaming'
  const notice = turnNotice(null, live.route)
  return (
    <div
      data-turn="assistant"
      aria-live="polite"
      className="flex flex-col gap-2.5"
    >
      <DroppedChips calls={calls} />
      {notice === null ? null : <NoticeRow notice={notice} />}
      {live.text === '' ? null : (
        <AskAnswer
          body={live.text}
          refs={[]}
          variant={variant}
          threadId={threadId}
          streaming
        />
      )}
      {live.phase === 'lost' ? (
        <div className="flex items-center gap-3">
          <span className="text-body text-graphite">Connection lost.</span>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      <FindTables
        calls={calls}
        turnId={null}
        question={live.question.body}
        variant={variant}
        threadId={threadId}
        line={modelLine(live.route)}
      />
      <AskCards cards={live.cards} />
      <CallStrip calls={calls} />
      {live.phase === 'stopped' ? (
        <span data-stopped className="mono text-micro text-graphite">
          {stoppedWords(calls)}
        </span>
      ) : null}
      {streaming ? (
        <div className="flex min-h-8 items-center gap-3">
          {live.text === '' ? (
            <span
              data-thinking
              className="flex items-center gap-2 mono text-micro text-graphite"
            >
              <Twinkle />
              {thinkingWords(calls)}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={onStop}
          >
            Stop
          </Button>
        </div>
      ) : null}
      {live.route === null ? null : (
        <span className="mono text-micro text-graphite">
          {modelLine(live.route)}
        </span>
      )}
    </div>
  )
}

/** Turns in order, with scope-change dividers and, on `/ask`, day dividers. */
export function AskTurns({
  turns,
  live,
  variant,
  threadId,
  onRetry,
  onStop,
}: {
  turns: ReadonlyArray<AskTurnView>
  live: LiveTurn | null
  variant: AnswerVariant
  threadId: string | null
  onRetry: (question: string) => void
  onStop: () => void
}) {
  const { today } = useClock()
  const all = live === null ? turns : [...turns, live.question]
  const latestAnswer =
    live === null
      ? [...all].reverse().find((t) => t.role === 'assistant')
      : undefined
  const out: Array<ReactNode> = []
  let scope: string | null = null
  let day: string | null = null
  for (const [i, t] of all.entries()) {
    if (t.role === 'user') {
      const key = scopeKey(t.scope)
      if (variant === 'page' && dayKey(t.createdAt) !== day) {
        day = dayKey(t.createdAt)
        out.push(
          <Divider key={`day-${t.id}`}>{formatWeekday(day, today)}</Divider>,
        )
      }
      if (scope !== null && key !== scope)
        out.push(
          <Divider key={`scope-${t.id}`}>
            Scope now {scopeWords(t.scope)} · {formatTime(t.createdAt)}
          </Divider>,
        )
      scope = key
      out.push(<QuestionTurn key={t.id} turn={t} />)
      continue
    }
    const question = all
      .slice(0, i)
      .reverse()
      .find((x) => x.role === 'user')
    out.push(
      <AnswerTurn
        key={t.id}
        turn={t}
        variant={variant}
        threadId={threadId}
        onRetry={
          question === undefined ? undefined : () => onRetry(question.body)
        }
        waiting={t.id !== latestAnswer?.id}
        question={question?.body ?? null}
      />,
    )
  }
  if (live !== null)
    out.push(
      <LiveAnswer
        key="live"
        live={live}
        variant={variant}
        threadId={threadId}
        onRetry={() => onRetry(live.question.body)}
        onStop={onStop}
      />,
    )
  return <div className="flex flex-col gap-6">{out}</div>
}

/**
 * The thread once the answer row has left `streaming` — the server settles
 * it as a stopped stream winds down — reading again until it has, at most
 * `tries` times. Null when the thread cannot be read.
 */
export async function settledThread(
  read: (threadId: string) => Promise<AskThreadView>,
  threadId: string,
  answerId: string | null,
  tries = 20,
  waitMs = 250,
): Promise<AskThreadView | null> {
  let last: AskThreadView | null = null
  for (let i = 0; i < tries; i++) {
    try {
      last = await read(threadId)
    } catch {
      return last
    }
    const row = last.turns.find((t) => t.id === answerId)
    if (answerId === null || (row !== undefined && row.state !== 'streaming'))
      return last
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  return last
}

/**
 * A thread's state and verbs: load it, ask into it, stop, retry, save.
 * `onThread` hears the id a first question created.
 */
export function useAskThread(
  threadId: string | null,
  onThread: (id: string) => void,
) {
  const [thread, setThread] = useState<AskThreadView | null>(null)
  const [live, setLive] = useState<LiveTurn | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reader = useRef<ReadableStreamDefaultReader<AskEvent> | null>(null)
  const stopping = useRef(false)
  const alive = useRef(true)
  const onThreadRef = useRef(onThread)
  onThreadRef.current = onThread

  const load = useCallback(async (id: string) => {
    try {
      const next = await getAskThread({ data: { threadId: id } })
      if (alive.current) setThread(next)
    } catch (err) {
      if (alive.current) {
        setThread(null)
        setError(err instanceof Error ? err.message : 'Could not read Ask')
      }
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      void reader.current?.cancel()
    }
  }, [])

  useEffect(() => {
    setError(null)
    if (threadId === null) setThread(null)
    else if (thread?.id !== threadId && live === null) void load(threadId)
  }, [threadId, load, thread?.id, live])

  const ask = useCallback(
    async (question: string, scope: ReadonlyArray<AskScopeChip>) => {
      // Read through a call: the refs change across the awaits below.
      const isAlive = () => alive.current
      const isStopping = () => stopping.current
      const now = new Date().toISOString()
      const start: LiveTurn = {
        question: {
          id: 'pending',
          role: 'user',
          body: question,
          refs: [],
          calls: [],
          cards: [],
          scope,
          state: null,
          route: null,
          savedAt: null,
          createdAt: now,
          hidden: false,
        },
        answerId: null,
        route: null,
        text: '',
        calls: [],
        cards: [],
        phase: 'streaming',
      }
      setLive(start)
      stopping.current = false
      let current = start
      let threadSeen = thread?.id ?? threadId
      try {
        const stream = await askQuestion({
          data: { threadId: threadSeen, question, scope: [...scope] },
        })
        const r = stream.getReader()
        if (!isAlive()) {
          await r.cancel()
          return
        }
        reader.current = r
        for (;;) {
          const next = await r.read()
          if (next.done) break
          const event = next.value
          if (event.type === 'turn' && threadSeen !== event.threadId) {
            threadSeen = event.threadId
            onThreadRef.current(event.threadId)
          }
          if (event.type === 'end') {
            const ended = event.turn
            const asked = current.question
            setThread((t) =>
              t !== null && t.id === threadSeen
                ? { ...t, turns: [...t.turns, asked, ended] }
                : {
                    id: threadSeen ?? '',
                    title: question,
                    createdAt: asked.createdAt,
                    turns: [asked, ended],
                  },
            )
            current = { ...current, phase: 'streaming' }
            setLive(null)
            return
          }
          current = applyAskEvent(current, event)
          setLive(current)
        }
        // Closed without its stored turn — a Stop resolves the read as done.
        // Keep what arrived on screen until the server has settled the row.
        if (isStopping()) {
          current = { ...current, phase: 'stopped' }
          setLive(current)
        }
        if (threadSeen !== null) {
          const settled = await settledThread(
            (id) => getAskThread({ data: { threadId: id } }),
            threadSeen,
            current.answerId,
          )
          if (!isAlive()) return
          if (settled !== null) setThread(settled)
        }
        setLive(null)
      } catch {
        if (!isAlive()) return
        current = { ...current, phase: 'lost' }
        setLive(current)
      } finally {
        reader.current = null
      }
    },
    [thread?.id, threadId],
  )

  // The read loop in `ask` sees the cancel as the stream closing.
  const stop = useCallback(() => {
    stopping.current = true
    void reader.current?.cancel()
  }, [])

  return { thread, live, error, ask, stop, reload: load }
}

/** The latest answer worth saving, for the foot's Save as note. */
export function latestSaveable(
  thread: AskThreadView | null,
): AskTurnView | null {
  if (thread === null) return null
  for (const t of [...thread.turns].reverse())
    if (t.role === 'assistant')
      return !t.hidden &&
        t.body !== '' &&
        (t.state === 'answered' || t.state === 'stopped')
        ? t
        : null
  return null
}

/**
 * "Save as note" on the latest answer. It stays where it is and swaps its
 * label to `Saved as note`; the note is filed on the records it cited.
 */
export function SaveAsNote({
  thread,
  onSaved,
}: {
  thread: AskThreadView | null
  onSaved?: () => void
}) {
  const [saving, setSaving] = useState(false)
  // The turn saved here, before the thread is read again.
  const [savedHere, setSavedHere] = useState<string | null>(null)
  const turn = latestSaveable(thread)
  if (turn === null) return null
  const saved = turn.savedAt !== null || savedHere === turn.id
  return (
    <Button
      variant="ghost"
      size="sm"
      pending={saving}
      disabled={saving || saved}
      title="Write this answer as a note filed on the records it cited"
      onClick={async () => {
        setSaving(true)
        try {
          await saveAskAnswerAsNote({ data: { turnId: turn.id } })
          setSavedHere(turn.id)
          onSaved?.()
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not save it')
        } finally {
          setSaving(false)
        }
      }}
    >
      {saved ? 'Saved as note' : 'Save as note'}
    </Button>
  )
}

/** The chips a question narrows to, inside the composer; each one removable. */
export function ComposerChips({
  scope,
  onRemove,
  webSources = [],
}: {
  scope: ReadonlyArray<AskScopeChip>
  onRemove: (chip: AskScopeChip) => void
  /** The plugins the web chip searches through, named on it. */
  webSources?: ReadonlyArray<string>
}) {
  if (scope.length === 0) return null
  return (
    <div data-chips className="flex flex-wrap items-center gap-1.5">
      {scope.map((c) => {
        const tip =
          c.kind === 'web' ? 'Leave the web out' : `Ask beyond ${c.name}`
        return (
          <span
            key={chipKey(c)}
            data-chip={c.kind}
            className={cn(
              'inline-flex h-5.5 max-w-56 items-center gap-1 rounded-md border border-rule px-1.5 text-label',
              c.kind === 'web' ? 'bg-bone' : 'bg-paper',
            )}
          >
            <span className="truncate">{chipLabel(c, webSources)}</span>
            <button
              type="button"
              aria-label={tip}
              title={tip}
              onClick={() => onRemove(c)}
              className="focus-ring -mr-0.5 text-graphite hover:text-foreground"
            >
              <X className="size-3" strokeWidth={1.75} />
            </button>
          </span>
        )
      })}
    </div>
  )
}

/**
 * The composer: one bordered box holding the scope chips, then the field
 * with ⌘↵ in its end lane — the one key, and no Send button. With
 * `onMention`, `@` in the field scopes the question to a space or record.
 */
export function AskComposer({
  value,
  onChange,
  onSend,
  onMention,
  scope = [],
  onRemoveChip,
  webSources = [],
  streaming,
  focus,
  className,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onMention?: ((chip: AskScopeChip) => void) | undefined
  /** The chips the question will be asked in. */
  scope?: ReadonlyArray<AskScopeChip>
  onRemoveChip?: ((chip: AskScopeChip) => void) | undefined
  webSources?: ReadonlyArray<string>
  streaming: boolean
  focus: number
  className?: string
}) {
  const field = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (focus > 0) field.current?.focus()
  }, [focus])
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (!streaming && value.trim() !== '') onSend()
    }
  }
  const fieldProps = {
    'aria-label': 'Ask',
    rows: 2,
    placeholder: 'Ask about your deals…',
    title:
      onMention === undefined ? undefined : '@ scopes to a space or record',
    className:
      'min-h-12 min-w-0 flex-1 resize-none bg-transparent text-body outline-none placeholder:text-graphite',
  }
  return (
    <div
      data-composer
      className={cn(
        'flex flex-col gap-2 rounded-md border border-rule bg-paper px-3 py-2 focus-within:border-foreground',
        className,
      )}
    >
      {onRemoveChip === undefined ? null : (
        <ComposerChips
          scope={scope}
          onRemove={onRemoveChip}
          webSources={webSources}
        />
      )}
      <div className="flex items-end gap-3">
        {onMention === undefined ? (
          <textarea
            {...fieldProps}
            ref={field}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <MentionTextarea
            {...fieldProps}
            fieldRef={field}
            value={value}
            onChange={onChange}
            onMention={onMention}
            onKeyDown={onKeyDown}
          />
        )}
        <span
          className="shrink-0 pb-0.5 mono text-micro text-graphite"
          title="Send"
        >
          ⌘↵
        </span>
      </div>
    </div>
  )
}
