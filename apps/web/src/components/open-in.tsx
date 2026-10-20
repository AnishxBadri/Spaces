import type { RecorderLink } from '#/lib/server-fns'

/** "Open in <provider>": a recorder's note where it was taken (D78). */
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
