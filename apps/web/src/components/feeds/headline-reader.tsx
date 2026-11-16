import { useClock } from '#/components/clock'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import { MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import { openAsk } from '#/lib/ask/dock-store'
import type { Headline } from '#/lib/server-fns'
import { FeedLogo } from './feed-logo'
import {
  askDraft,
  headlinesOnlyLine,
  paragraphsOf,
  siteOf,
  storyStamp,
} from './feed-words'

/**
 * The story read beside the list: a 48px bar (the source, when, `Open
 * article ↗` and the `···`), then the headline, the photo at full measure,
 * the feed's own text as serif prose on a 640px measure, and a foot that
 * hands off to the publisher with the feed's spaces.
 * - Only the feed's text is shown, as plain paragraphs, never as HTML; the
 *   article page is never fetched. A feed with no text says so.
 * - The photo is our own blob; one the worker has yet to store is a bone
 *   plate with the Twinkle, one it never will is no photo at all.
 * - The bar stays while the article scrolls under it; the caller keys this
 *   by story, so a new story opens at its top.
 */
export function HeadlineReader({
  headline: h,
  spaces,
}: {
  headline: Headline
  /** The feed's spaces by path: `Aerospace › Launch, Proptech`. */
  spaces: string
}) {
  const { today } = useClock()
  const paragraphs = paragraphsOf(h.summary)
  const site = siteOf(h)
  const url = h.url
  const menu: Array<MoreMenuEntry> = [
    ...(url === null ? [] : [{ label: 'Copy link', copy: () => url }]),
    {
      label: 'Ask about this',
      title: 'Ask with this headline and its link',
      onSelect: () => openAsk({ draft: askDraft(h) }),
      opens: true,
    },
  ]
  return (
    <section
      aria-label="Reader"
      data-reader
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-rule pr-4 pl-6">
        <FeedLogo name={h.feedName} logoUrl={h.logoUrl} />
        <span className="min-w-0 truncate text-ui font-medium">
          {h.feedName}
        </span>
        <time
          dateTime={h.publishedAt}
          className="min-w-0 flex-1 truncate mono text-micro text-graphite"
        >
          {storyStamp(h.publishedAt, today)}
        </time>
        {h.url === null ? null : (
          <Button variant="outline" asChild shortcut="O">
            <a href={h.url} target="_blank" rel="noopener noreferrer">
              Open article ↗
            </a>
          </Button>
        )}
        <MoreMenu variant="head" label={h.title} items={menu} forceMenu />
      </div>
      <div data-reader-scroll className="min-h-0 flex-1 overflow-y-auto">
        <article className="flex max-w-160 flex-col gap-4.5 px-6 pt-7 pb-10">
          <h2 className="title-serif text-foreground">{h.title}</h2>
          {h.photoUrl !== null ? (
            <img
              src={h.photoUrl}
              alt=""
              data-reader-photo
              className="h-50 w-full shrink-0 border border-hairline bg-paper object-cover"
            />
          ) : h.photoPending ? (
            <div
              data-reader-photo="pending"
              className="flex h-50 shrink-0 items-center justify-center border border-rule bg-bone"
            >
              <Twinkle label="Fetching the photo" />
            </div>
          ) : null}
          {paragraphs.length === 0 ? (
            <p data-headlines-only className="text-ui text-graphite">
              {headlinesOnlyLine(h.feedName)}
            </p>
          ) : (
            <div className="flex flex-col gap-3.5">
              {paragraphs.map((p, i) => (
                <p key={i} className="prose-serif text-foreground">
                  {p}
                </p>
              ))}
            </div>
          )}
          {(paragraphs.length > 0 && h.url !== null) || spaces !== '' ? (
            <footer className="flex items-center justify-between gap-4 border-t border-rule pt-3.5">
              {paragraphs.length > 0 && h.url !== null ? (
                <a
                  href={h.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="focus-ring rounded-md text-ui font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Continue on {site ?? 'its site'} ↗
                </a>
              ) : null}
              {spaces === '' ? null : (
                <span className="min-w-0 truncate text-label text-graphite">
                  {spaces}
                </span>
              )}
            </footer>
          ) : null}
        </article>
      </div>
    </section>
  )
}
