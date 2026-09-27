import { Globe } from 'lucide-react'
import type { CapturedPage } from '#/lib/server-fns'

/**
 * The heading of a captured page's card in the review inbox (SPA-134). A
 * capture usually names somebody we hold no record for, so what its read
 * proposes sits on the captured document, and the card is headed by the
 * page — its title, and the address it was captured from — where a record
 * card has its chip. The rows under it are the ordinary suggestion entries:
 * accepting the identity matches or creates the person and files the page
 * on them, and the page's fields then apply to that person.
 *
 * The header row's type follows the column-run group's (SPA-122).
 */
export function CapturedPageHeading({ page }: { page: CapturedPage }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <Globe className="size-3.5 shrink-0 text-graphite" strokeWidth={1.75} />
        <h2 className="min-w-0 truncate font-serif text-lg leading-5.5 font-semibold">
          {page.title}
        </h2>
        <span className="shrink-0 label-caps text-graphite">
          — from a captured page
        </span>
      </div>
      {page.url === null ? null : (
        <a
          href={page.url}
          target="_blank"
          rel="noreferrer"
          className="focus-ring min-w-0 truncate mono text-micro text-graphite hover:text-foreground hover:underline"
        >
          {page.url}
        </a>
      )}
    </div>
  )
}
