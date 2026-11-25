import { useEffect, useState } from 'react'
import { Twinkle } from '#/components/twinkle'
import { getEmail } from '#/lib/server-fns'
import type { EmailDetail } from '#/lib/server-fns'
import { FoldedCard, OpenCard, threadCards } from './message-card'
import type { FileActions, ReplyMode } from './message-card'

/**
 * An email thread as a column of message cards, oldest first, the newest
 * last: the window's own message open, every earlier one folded until a
 * click unfolds it in place, and an open one folds again from its header.
 * While a draft is written every card folds,
 * the draft standing under them as the last card.
 * - It draws only the cards; the bone ground that holds them is the caller's,
 *   so a window and a page pane can each frame it.
 * - An earlier message is read in full the first time it unfolds.
 */
export function EmailThread({
  email,
  recordId,
  today,
  drafting,
  actions,
  onDraft,
}: {
  /** The newest message: the one the window opened on, read in full. */
  email: EmailDetail
  recordId: string | null
  today: string
  /** A draft is the last card: every message folds above it. */
  drafting: boolean
  actions: FileActions
  onDraft: (messageId: string, mode: ReplyMode) => void
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() =>
    drafting ? new Set() : new Set([email.id]),
  )
  const cards = threadCards(email.thread.earlier, email)
  const fold = (id: string) =>
    setOpen((prev) => new Set([...prev].filter((held) => held !== id)))
  return (
    <>
      <Categories categories={email.categories} />
      {cards.map((head) =>
        open.has(head.id) ? (
          head.id === email.id ? (
            <OpenCard
              key={head.id}
              email={email}
              today={today}
              actions={actions}
              onDraft={onDraft}
              onFold={() => fold(head.id)}
            />
          ) : (
            <EarlierCard
              key={head.id}
              id={head.id}
              recordId={recordId}
              today={today}
              actions={actions}
              onDraft={onDraft}
              onFold={() => fold(head.id)}
            />
          )
        ) : (
          <FoldedCard
            key={head.id}
            head={head}
            today={today}
            onOpen={() => setOpen((prev) => new Set([...prev, head.id]))}
          />
        ),
      )}
    </>
  )
}

/** An earlier message unfolded: read once, then an open card. */
function EarlierCard({
  id,
  recordId,
  today,
  actions,
  onDraft,
  onFold,
}: {
  id: string
  recordId: string | null
  today: string
  actions: FileActions
  onDraft: (messageId: string, mode: ReplyMode) => void
  onFold: () => void
}) {
  const [email, setEmail] = useState<EmailDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    getEmail({ data: { id, recordId } })
      .then((e) => {
        if (live) setEmail(e)
      })
      .catch((err: unknown) => {
        if (live)
          setError(
            err instanceof Error ? err.message : 'Could not read the email',
          )
      })
    return () => {
      live = false
    }
  }, [id, recordId])
  if (email !== null)
    return (
      <OpenCard
        email={email}
        today={today}
        actions={actions}
        onDraft={onDraft}
        onFold={onFold}
      />
    )
  return (
    <div
      data-card={id}
      className="flex h-11 shrink-0 items-center border border-rule bg-paper px-4"
    >
      {error === null ? (
        <Twinkle size={14} />
      ) : (
        <p className="text-ui text-destructive">{error}</p>
      )}
    </div>
  )
}

const CATEGORY_WORD = (c: string) => c.charAt(0).toUpperCase() + c.slice(1)

/** The classify lane's labels, as chips over the thread. */
function Categories({ categories }: { categories: ReadonlyArray<string> }) {
  if (categories.length === 0) return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {categories.map((c) => (
        <span
          key={c}
          data-category={c}
          className="flex h-5 items-center rounded-md border border-rule bg-paper px-1.5 text-label text-graphite"
        >
          {CATEGORY_WORD(c)}
        </span>
      ))}
    </div>
  )
}
