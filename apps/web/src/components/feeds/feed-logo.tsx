import { PictureMark } from '#/components/record/record-parts'

/**
 * A feed's mark, 16px: its stored logo when the worker has fetched one,
 * else the first letter of its name in serif on an ink square.
 * - `logoUrl` is only ever the blob store's address for a stored logo, never
 *   the publisher's: a feed's logo is never hotlinked.
 */
export function FeedLogo({
  name,
  logoUrl,
}: {
  name: string
  logoUrl?: string | null | undefined
}) {
  if (typeof logoUrl === 'string')
    return <PictureMark src={logoUrl} size={16} />
  const letter = name.trim().charAt(0).toUpperCase()
  return (
    <span
      aria-hidden
      data-feed-monogram
      className="flex size-4 shrink-0 items-center justify-center bg-hairline font-serif text-field font-semibold text-paper"
    >
      {letter}
    </span>
  )
}
