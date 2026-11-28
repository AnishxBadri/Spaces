import { DitherNoun } from '#/components/dither-noun'
import { Button } from '#/components/ui/button'

/**
 * A meeting that is over with no write-up: the note drawing on bone,
 * `No write-up` in serif, `Write it up` in pine and, while the meeting
 * still owes one, `Nothing to note` beside it. Once marked, `Write it up`
 * stands alone, so one can still be written later.
 */
export function NoWriteUpCard({
  writing,
  onWriteUp,
  onNothingToNote,
}: {
  writing: boolean
  onWriteUp: () => void
  /** Null when the meeting is marked already, or cannot hold the mark. */
  onNothingToNote: (() => void) | null
}) {
  return (
    <section
      aria-label="No write-up"
      data-no-write-up
      className="flex shrink-0 border border-hairline bg-paper"
    >
      <div className="flex w-38 shrink-0 items-center justify-center border-r border-hairline bg-bone px-4 py-5">
        <DitherNoun
          kind="notes"
          crop={{ x: 26, y: 6, width: 112, height: 84 }}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-3.5 p-5">
        <h3 className="font-serif text-head font-semibold text-foreground">
          No write-up
        </h3>
        <div className="flex items-center gap-2">
          <Button pending={writing} disabled={writing} onClick={onWriteUp}>
            Write it up
          </Button>
          {onNothingToNote === null ? null : (
            <Button
              variant="outline"
              disabled={writing}
              onClick={onNothingToNote}
            >
              Nothing to note
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
