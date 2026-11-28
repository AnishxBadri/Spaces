import { DitherNoun } from '#/components/dither-noun'
import { Button } from '#/components/ui/button'

/**
 * A meeting that is over and owes a write-up: the note drawing on bone,
 * `No write-up` in serif and `Write it up` in pine.
 */
export function NoWriteUpCard({
  writing,
  onWriteUp,
}: {
  writing: boolean
  onWriteUp: () => void
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
        </div>
      </div>
    </section>
  )
}
