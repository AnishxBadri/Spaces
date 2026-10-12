import { Link, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
import { scopeKey, scopeWords } from '#/lib/ask/types'
import { cn } from '#/lib/utils'
import { AskAnswer, RefChip } from './ask-answer'
import { AskCards } from './ask-card'
import type { AnswerVariant } from './ask-answer'

/**
 * One Ask thread, shared by the dock and `/ask`: the turns as stored, the
 * turn streaming now, and the composer. (D70)
 * - Your turn is a bone block with a hairline, right-aligned, at most three
 *   quarters of the column, its time under it; the answer has no box.
 * - A scope change between questions is a centred mono divider.
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

const time = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const dayOf = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A centred mono divider across the column: a scope change or a day. */
export function Divider({ children }: { children: ReactNode }) {
  return (
    <div
      role="separator"
      className="flex items-center gap-3 mono text-micro text-graphite"
    >
      <span className="h-px flex-1 bg-rule" />
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-rule" />
    </div>
  )
}

/** Your question: bone, a hairline, right-aligned, its time under it. */
export function QuestionTurn({ turn }: { turn: AskTurnView }) {
  return (
    <div data-turn="user" className="flex flex-col items-end gap-1">
      <div className="max-w-3/4 border border-hairline bg-bone px-3 py-2 text-body whitespace-pre-wrap">
        {turn.body}
      </div>
      <span className="mono text-micro text-graphite">
        {time(turn.createdAt)}
      </span>
    </div>
  )
}

const CALL_WORD: Record<AskCall['state'], string> = {
  running: 'running',
  done: '',
  refused: 'refused',
  failed: 'failed',
}

/** The tools a turn called, each with what it asked and found. */
export function CallStrip({ calls }: { calls: ReadonlyArray<AskCall> }) {
  if (calls.length === 0) return null
  return (
    <ul
      aria-label="Tools called"
      className="flex flex-wrap gap-x-3 gap-y-1 mono text-micro text-graphite"
    >
      {calls.map((c, i) => (
        <li key={i} className="flex gap-1.5" title={c.reason}>
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

/** The answer's foot: the model or the route, then its sources. */
function AnswerFoot({ turn }: { turn: AskTurnView }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 mono text-micro text-graphite">
        {turn.route === null ? null : <span>{turn.route}</span>}
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
}: {
  turn: AskTurnView
  variant: AnswerVariant
  threadId: string | null
  onRetry?: (() => void) | undefined
  /** Not the latest answer: its undecided cards wait in Review. */
  waiting?: boolean
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
  return (
    <div data-turn="assistant" className="flex flex-col gap-2.5">
      {turn.state === 'no_provider' ? (
        <p className="text-body">
          Ask needs a model to answer.{' '}
          <Link
            to="/settings/models"
            className="focus-ring text-primary hover:underline"
          >
            Add a model ›
          </Link>
        </p>
      ) : turn.state === 'empty' ? (
        <div className="flex flex-col gap-1">
          <p className="text-body">Nothing found.</p>
        </div>
      ) : turn.state === 'refused' ||
        turn.state === 'capped' ||
        turn.state === 'failed' ? (
        <>
          {body}
          <p className="text-body text-graphite">{turn.route}</p>
          {onRetry && turn.state === 'failed' ? (
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
      <AskCards cards={turn.cards} waiting={waiting} />
      {turn.state === 'stopped' ? (
        <span className="mono text-micro text-graphite">stopped</span>
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

/** The answer arriving now: its state word, the text so far, the strip. */
export function LiveAnswer({
  live,
  variant,
  threadId,
  onRetry,
}: {
  live: LiveTurn
  variant: AnswerVariant
  threadId: string | null
  onRetry: () => void
}) {
  const running = live.calls.some((c) => c.call.state === 'running')
  const word =
    live.phase === 'lost'
      ? null
      : live.phase === 'stopped'
        ? 'stopped'
        : live.text !== ''
          ? null
          : running
            ? 'computing.'
            : 'reading.'
  return (
    <div
      data-turn="assistant"
      aria-live="polite"
      className="flex flex-col gap-2.5"
    >
      {live.text === '' ? null : (
        <AskAnswer
          body={live.text}
          refs={[]}
          variant={variant}
          threadId={threadId}
          streaming
        />
      )}
      {word === null ? null : (
        <span className="mono text-micro text-graphite">{word}</span>
      )}
      {live.phase === 'lost' ? (
        <div className="flex items-center gap-3">
          <span className="text-body text-graphite">Connection lost.</span>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      <AskCards cards={live.cards} />
      <CallStrip calls={live.calls.map((c) => c.call)} />
      {live.route === null ? null : (
        <span className="mono text-micro text-graphite">{live.route}</span>
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
}: {
  turns: ReadonlyArray<AskTurnView>
  live: LiveTurn | null
  variant: AnswerVariant
  threadId: string | null
  onRetry: (question: string) => void
}) {
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
      if (variant === 'page' && dayOf(t.createdAt) !== day) {
        day = dayOf(t.createdAt)
        out.push(<Divider key={`day-${t.id}`}>{day}</Divider>)
      }
      if (scope !== null && key !== scope)
        out.push(
          <Divider key={`scope-${t.id}`}>
            Scope · {scopeWords(t.scope)}
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

/** "Save as note" on the latest answer; lands on the note it wrote. */
export function SaveAsNote({
  thread,
  onSaved,
}: {
  thread: AskThreadView | null
  onSaved?: () => void
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const turn = latestSaveable(thread)
  if (turn === null) return null
  const saved = turn.savedAt !== null
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
          const { noteId } = await saveAskAnswerAsNote({
            data: { turnId: turn.id },
          })
          toast('Saved as a note')
          onSaved?.()
          await router.navigate({ to: '/notes/$noteId', params: { noteId } })
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

/**
 * The composer: a field, ⌘↵ printed in its end lane as the one key, and
 * Send — or Stop while an answer streams.
 */
export function AskComposer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  focus,
  className,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  streaming: boolean
  focus: number
  className?: string
}) {
  const field = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (focus > 0) field.current?.focus()
  }, [focus])
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <textarea
        ref={field}
        aria-label="Ask"
        rows={2}
        value={value}
        placeholder="Ask about your deals…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            if (!streaming && value.trim() !== '') onSend()
          }
        }}
        className="focus-ring min-h-16 w-full resize-none rounded-md border border-rule bg-paper px-3 py-2 text-body"
      />
      <div className="flex items-center justify-end gap-3">
        <span className="mono text-micro text-graphite">⌘↵</span>
        {streaming ? (
          <Button variant="outline" size="sm" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={value.trim() === ''}
            title="Send (⌘↵)"
            onClick={onSend}
          >
            Send
          </Button>
        )}
      </div>
    </div>
  )
}
