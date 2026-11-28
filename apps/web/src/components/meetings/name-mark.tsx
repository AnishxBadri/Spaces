/**
 * A word beside a person's name in the meeting's rail, `HOST` or `NEW`: a
 * 6px ink square, then the word in mono caps. Smaller than the title's
 * stamp, so a name never reads as a heading.
 */
export function NameMark({ word }: { word: 'Host' | 'New' }) {
  return (
    <span
      data-name-mark={word.toLowerCase()}
      className="flex shrink-0 items-center gap-1.25"
    >
      <span aria-hidden className="size-1.5 shrink-0 bg-hairline" />
      <span className="mono text-field tracking-[0.08em] text-foreground uppercase">
        {word}
      </span>
    </span>
  )
}
