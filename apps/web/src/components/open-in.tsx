import type { RecorderLink } from '#/lib/server-fns'
import { viaLabel } from '#/lib/notes/via-mark'
import type { NoteVia } from '#/lib/notes/via-mark'

/** "Open in <provider>": a recorder's note where it was taken. */
export function OpenIn({ link }: { link: RecorderLink | null }) {
  if (link === null) return null
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      className="focus-ring shrink-0 mono text-micro text-foreground hover:underline"
    >
      Open in {link.provider} ›
    </a>
  )
}

/** "via <tool> · <author>": a note filed from a recorder. */
export function ViaMark({ via }: { via: NoteVia | null }) {
  if (via === null) return null
  return (
    <span className="shrink-0 mono text-micro text-graphite">
      {viaLabel(via)}
    </span>
  )
}
