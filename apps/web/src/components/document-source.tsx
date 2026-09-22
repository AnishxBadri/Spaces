import { ExternalLink } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '#/lib/utils'

/**
 * The two marks a document carries when it came from a storage source —
 * SPA-78, `docs/spec-storage-sources.md` §8 and §12.
 *
 * Both are shared by `/documents` and the Files tab because both rows answer
 * the same two questions about the same five columns, and a second spelling
 * of "gone" is how the two surfaces would come to disagree about what the
 * word means. Neither renders anything for a document nobody linked, which
 * is every document until the first storage-source plugin lands: a null
 * `external_url` is no action, not a disabled one, and a null
 * `external_status` is no marker, not a dash.
 */

/**
 * The file was deleted on the provider's side and ours was kept (§7, §8).
 * Warning rather than destructive: nothing of ours is lost — the bytes, the
 * extracted text and every filing stay — but the link on the row now points
 * at something that is not there, and the reader needs to know that before
 * they click it.
 */
export function GoneMarker() {
  return (
    <span
      title="Deleted in the source. Our copy stays — we never delete theirs, and they never delete ours."
      className="shrink-0 mono text-micro text-warning"
    >
      gone
    </span>
  )
}

/**
 * "Open in source" — the provider's own link, in their tab.
 *
 * `rel="noopener noreferrer"` because the href is a value a connector wrote
 * into our database, so the opened page gets no handle on this one. The
 * click stops propagating: on both surfaces the row behind it opens the
 * preview, and one click must not do two things.
 */
export function OpenInSourceButton({
  url,
  filename,
  className,
}: {
  url: string
  filename: string
  className?: string
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      asChild
      className={cn('text-graphite', className)}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${filename} in source`}
        aria-label={`Open ${filename} in source`}
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink />
      </a>
    </Button>
  )
}
