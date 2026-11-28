import { Fragment } from 'react'
import { formatTime } from '@spaces/core/format'
import { RefChip } from '#/components/ask/ask-answer'
import { Button } from '#/components/ui/button'
import { AskButton } from '#/components/ui/ask-control'
import type { AskRef } from '#/lib/ask/types'
import {
  briefSegments,
  citationNumbers,
  parseBrief,
  settledText,
  streamingRefs,
} from '#/lib/meetings/brief'
import type { PrepEvent } from '#/lib/server-fns'
import { SheetCard } from './sheet-card'

/** The brief's state in the sheet: nothing until asked, and never stored. */
export type PrepState =
  | { phase: 'idle' }
  | {
      phase: 'running'
      line: string | null
      sensitive: boolean
      /** The sources the model reads; null until the route is known. */
      sources: number | null
      text: string
    }
  | {
      phase: 'done'
      line: string
      sensitive: boolean
      body: string
      refs: ReadonlyArray<AskRef>
      markdown: string
      /** `09:12`: the reader's clock when the brief came in. */
      writtenAt: string
    }
  | { phase: 'refused'; line: string }
  | { phase: 'failed'; message: string }

/** One brief event applied to the sheet's state; `at` is when it arrived. */
export function applyPrepEvent(
  state: PrepState,
  event: PrepEvent,
  at: Date = new Date(),
): PrepState {
  switch (event.type) {
    case 'route':
      return {
        phase: 'running',
        line: event.line,
        sensitive: event.sensitive,
        sources: event.sources,
        text: '',
      }
    case 'text':
      return state.phase === 'running'
        ? { ...state, text: state.text + event.text }
        : state
    case 'done':
      return state.phase === 'running'
        ? {
            phase: 'done',
            line: state.line ?? '',
            sensitive: state.sensitive,
            body: event.body,
            refs: event.refs,
            markdown: event.markdown,
            writtenAt: formatTime(at),
          }
        : state
    case 'refused':
      return { phase: 'refused', line: event.line }
    case 'failed':
      return { phase: 'failed', message: event.message }
  }
}

/** What the working button says: what the run is reading. */
export function workingLabel(sources: number | null): string {
  if (sources === null) return 'Reading sources'
  return `Reading ${String(sources)} ${sources === 1 ? 'source' : 'sources'}`
}

function Cited({
  text,
  refs,
  numbers,
}: {
  text: string
  refs: ReadonlyArray<AskRef>
  numbers: ReadonlyMap<string, number>
}) {
  const segments = briefSegments(text, refs)
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'ref' ? (
          <Fragment key={`${s.ref.ref}-${String(i)}`}>
            {/* Citations side by side read `[3] [4]`. */}
            {i > 0 && segments[i - 1].kind === 'ref' ? ' ' : null}
            <RefChip source={s.ref} n={numbers.get(s.ref.ref) ?? 0} />
          </Fragment>
        ) : s.strong ? (
          <strong key={i} className="font-medium">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  )
}

/**
 * The brief's four parts, each in its 72px label lane, every claim cited
 * `[1]` as Ask cites. Text before the first part leads them; an answer with
 * no parts shows whole as that lead.
 */
export function BriefParts({
  body,
  refs,
}: {
  body: string
  refs: ReadonlyArray<AskRef>
}) {
  const { lead, parts } = parseBrief(body)
  const numbers = citationNumbers(body, refs)
  return (
    <div data-brief-parts className="flex flex-col gap-3.5">
      {lead === '' ? null : (
        <p className="text-ui text-foreground">
          <Cited text={lead} refs={refs} numbers={numbers} />
        </p>
      )}
      {parts.map((p) => (
        <div key={p.label} data-brief-part={p.label} className="flex gap-3">
          <span className="w-18 shrink-0 text-label leading-5 text-graphite">
            {p.label}
          </span>
          <p className="min-w-0 flex-1 text-ui text-foreground">
            <Cited text={p.text} refs={refs} numbers={numbers} />
          </p>
        </div>
      ))}
    </div>
  )
}

/** A route worth a word: the gate sent the brief to a local model. */
function SensitiveLine({ prep }: { prep: PrepState }) {
  if (prep.phase !== 'running' && prep.phase !== 'done') return null
  if (!prep.sensitive || prep.line === null) return null
  return (
    <p data-prep-route className="mono text-micro text-warning">
      {prep.line}
    </p>
  )
}

/**
 * The brief, before the meeting: one `Brief` button until asked, the run in
 * place while the button says what it reads, then four cited parts with
 * `Ask about this` and `Save as note`. Nothing is kept unless saved. A
 * meeting with no linked record has nothing to brief on and no card.
 */
export function BriefCard({
  prep,
  canPrep,
  saving,
  saved,
  asking,
  onPrep,
  onSave,
  onAsk,
}: {
  prep: PrepState
  /** The meeting has a linked record to brief on. */
  canPrep: boolean
  saving: boolean
  saved: boolean
  /** `Ask about this` is opening the thread. */
  asking: boolean
  onPrep: () => void
  onSave: (markdown: string) => void
  onAsk: (body: string, route: string | null) => void
}) {
  if (!canPrep && prep.phase === 'idle') return null

  if (prep.phase === 'done' && prep.body !== '') {
    const done = prep
    return (
      <SheetCard
        label="Brief"
        action={
          <span data-brief-written className="mono text-micro text-graphite">
            Written {done.writtenAt}
          </span>
        }
      >
        <div className="flex flex-col gap-3.5 px-4 pt-7 pb-4">
          <BriefParts body={done.body} refs={done.refs} />
          <SensitiveLine prep={done} />
        </div>
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-t border-rule px-4">
          <AskButton
            size="sm"
            working={asking}
            disabled={asking}
            title="Open this brief in Ask, with the meeting’s records as its scope"
            onClick={() =>
              onAsk(done.body, done.line === '' ? null : done.line)
            }
          >
            Ask about this
          </AskButton>
          <Button
            variant="outline"
            size="sm"
            pending={saving}
            disabled={saving || saved}
            onClick={() => onSave(done.markdown)}
          >
            {saved ? 'Saved as note' : 'Save as note'}
          </Button>
        </div>
      </SheetCard>
    )
  }

  const running = prep.phase === 'running' ? prep : null
  const streamed = running === null ? '' : settledText(running.text)
  return (
    <section
      aria-label="Brief"
      data-brief-card
      className="flex shrink-0 flex-col border border-rule bg-paper"
    >
      <div className="flex h-11 shrink-0 items-center gap-3 px-4">
        <AskButton
          size="sm"
          working={running !== null}
          disabled={running !== null || !canPrep}
          title="Brief me for this meeting; nothing is kept unless saved"
          onClick={onPrep}
        >
          {running === null ? 'Brief' : workingLabel(running.sources)}
        </AskButton>
      </div>
      {prep.phase === 'refused' ? (
        <p
          data-prep-refused
          className="border-t border-rule px-4 py-3 text-ui text-warning"
        >
          {prep.line}
        </p>
      ) : prep.phase === 'failed' ? (
        <p className="border-t border-rule px-4 py-3 text-ui text-destructive">
          {prep.message}
        </p>
      ) : streamed.trim() === '' ? null : (
        <div className="flex flex-col gap-3.5 border-t border-rule px-4 pt-3.5 pb-4">
          <BriefParts body={streamed} refs={streamingRefs(streamed)} />
          <SensitiveLine prep={prep} />
        </div>
      )}
    </section>
  )
}
