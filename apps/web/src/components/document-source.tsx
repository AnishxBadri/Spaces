import { ExternalLink } from 'lucide-react'
import { Button } from './ui/button'
import { storageLinkProvider } from '#/lib/documents/storage-link'
import { cn } from '#/lib/utils'

/**
 * The marks a document carries when it came from a storage source, and its
 * external links.
 * - Shared by `/files` and the Files tab so the surfaces cannot disagree
 *   about what "gone" or an external link looks like.
 * - A document nobody linked renders nothing: a null `external_url` is no
 *   action, not a disabled one; a null `external_status` is no marker, not
 *   a dash.
 */

/**
 * The file was deleted on the provider's side and ours was kept.
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
  // Named for the provider by the link's host: "Open in Drive".
  const where = storageLinkProvider(url)?.label ?? 'source'
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
        title={`Open in ${where}`}
        aria-label={`Open ${filename} in ${where}`}
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink />
      </a>
    </Button>
  )
}

/**
 * **"Open source"** — a clipped article's own address, where a row with
 * bytes offers Download.
 * - Not `OpenInSourceButton`: that is a provider's copy of bytes we also
 *   hold; this is the only place there is. A clip has a null `blob_sha` by
 *   design, so `getDocumentDownloadUrl` throws for it — don't soften the
 *   throw, don't render Download. A clip's `external_url` is always null, so
 *   the two never appear together.
 * - `rel="noopener noreferrer"`: the href is a URL a person pasted. The
 *   click stops propagating because the row behind it opens the preview.
 */
export function OpenSourceButton({
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
        title={`Open source — ${url}`}
        aria-label={`Open source ${filename}`}
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink />
      </a>
    </Button>
  )
}
