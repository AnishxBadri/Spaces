import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import type { PrepEvent } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/** Prep's state in the sheet: nothing until asked, and never stored. */
export type PrepState =
  | { phase: 'idle' }
  | { phase: 'running'; line: string | null; sensitive: boolean; text: string }
  | { phase: 'done'; line: string; sensitive: boolean; markdown: string }
  | { phase: 'refused'; line: string }
  | { phase: 'failed'; message: string }

/** One Prep event applied to the sheet's state. */
export function applyPrepEvent(state: PrepState, event: PrepEvent): PrepState {
  switch (event.type) {
    case 'route':
      return {
        phase: 'running',
        line: event.line,
        sensitive: event.sensitive,
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
            markdown: event.markdown,
          }
        : state
    case 'refused':
      return { phase: 'refused', line: event.line }
    case 'failed':
      return { phase: 'failed', message: event.message }
  }
}

function PrepBody({ prep }: { prep: PrepState }) {
  switch (prep.phase) {
    case 'idle':
      return null
    case 'refused':
      return (
        <p data-prep-refused className="text-ui text-warning">
          {prep.line}
        </p>
      )
    case 'failed':
      return <p className="text-ui text-destructive">{prep.message}</p>
    case 'running':
    case 'done': {
      const text = prep.phase === 'done' ? prep.markdown : prep.text
      return (
        <div className="flex flex-col gap-2">
          {prep.line === null ? (
            <Twinkle size={14} />
          ) : (
            <span
              data-prep-route
              className={cn(
                'mono text-micro',
                prep.sensitive ? 'text-warning' : 'text-graphite',
              )}
            >
              {prep.line}
            </span>
          )}
          {text === '' ? null : (
            <div className="text-ui whitespace-pre-wrap text-foreground">
              {text}
            </div>
          )}
        </div>
      )
    }
  }
}

/**
 * The brief, before the meeting: Prep on demand, streamed in place and kept
 * only by `Save as note`. Prep needs a linked record to brief on; a meeting
 * with none has no card.
 */
export function BriefCard({
  prep,
  canPrep,
  saving,
  saved,
  onPrep,
  onSave,
}: {
  prep: PrepState
  /** The meeting has a linked record to brief on. */
  canPrep: boolean
  saving: boolean
  saved: boolean
  onPrep: () => void
  onSave: (markdown: string) => void
}) {
  if (!canPrep && prep.phase === 'idle') return null
  const done = prep.phase === 'done' && prep.markdown !== '' ? prep : null
  return (
    <section
      aria-label="Brief"
      data-brief-card
      className="flex shrink-0 flex-col border border-rule bg-paper"
    >
      <div className="flex min-h-11 shrink-0 items-center gap-3 px-4 py-1.5">
        {done === null ? (
          <Button
            variant="outline"
            size="sm"
            title="Brief me on the linked records; nothing is kept unless saved"
            pending={prep.phase === 'running'}
            disabled={prep.phase === 'running' || !canPrep}
            onClick={onPrep}
          >
            Prep
          </Button>
        ) : (
          <>
            <span className="mr-auto mono text-micro text-graphite">
              Not kept unless saved
            </span>
            <Button
              size="sm"
              pending={saving}
              disabled={saving || saved}
              onClick={() => onSave(done.markdown)}
            >
              {saved ? 'Saved as note' : 'Save as note'}
            </Button>
          </>
        )}
      </div>
      {prep.phase === 'idle' ? null : (
        <section aria-label="Prep" className="border-t border-rule px-4 py-3">
          <PrepBody prep={prep} />
        </section>
      )}
    </section>
  )
}
