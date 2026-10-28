import { File, Hash, MessageSquare, Pilcrow } from 'lucide-react'
import { HoverCard } from 'radix-ui'
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { parseRef } from '@spaces/core/context/ref'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { pageOf } from '#/components/palette-preview'
import { Twinkle } from '#/components/twinkle'
import { previewAskRef } from '#/lib/server-fns'
import type { AskRefPreview } from '#/lib/server-fns'

/**
 * A citation's passage on hover: a 340px dithered sheet with the source's
 * glyph, its mono name and page, the passage in serif on bone, and where it
 * is filed with its day.
 * - Fetched the first time the chip is hovered, and once per ref for the
 *   page's life: a second hover reads the first answer.
 * - Only refs that name a passage preview; a record chip is its own link.
 */

const PREVIEWED = new Set(['doc', 'note', 'memo', 'interaction', 'attr'])

/** True when a ref names something the hover can show a passage of. */
export function previewable(ref: string): boolean {
  const p = parseRef(ref)
  return p !== null && PREVIEWED.has(p.kind)
}

const asked = new Map<string, Promise<AskRefPreview | null>>()

function load(ref: string): Promise<AskRefPreview | null> {
  let hit = asked.get(ref)
  if (hit === undefined) {
    hit = previewAskRef({ data: { ref } }).catch(() => {
      // A failed read is asked again next hover.
      asked.delete(ref)
      return null
    })
    asked.set(ref, hit)
  }
  return hit
}

type Loaded = { ref: string; preview: AskRefPreview | null }

function useRefPreview(ref: string, open: boolean): Loaded | undefined {
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined)
  useEffect(() => {
    if (!open || loaded?.ref === ref) return
    let alive = true
    void load(ref).then((preview) => {
      if (alive) setLoaded({ ref, preview })
    })
    return () => {
      alive = false
    }
  }, [open, ref, loaded?.ref])
  return loaded?.ref === ref ? loaded : undefined
}

const GLYPH = {
  file: File,
  note: Pilcrow,
  interaction: MessageSquare,
  attribute: Hash,
} as const

/** The sheet's body once the read is back; exported for its test. */
export function RefPreviewBody({
  preview,
  label,
}: {
  preview: AskRefPreview | null
  /** The chip's own words, the head while nothing came back. */
  label: string
}) {
  const { today } = useClock()
  if (preview === null)
    return (
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate mono text-micro">{label}</span>
        <span className="shrink-0 text-label text-graphite">
          Nothing to show
        </span>
      </div>
    )
  const Icon = GLYPH[preview.kind]
  const page = pageOf(preview.page, preview.pages)
  const day = preview.day === null ? '' : formatDay(preview.day, today)
  const where = [preview.on === null ? '' : `On ${preview.on}`, day]
    .filter((x) => x !== '')
    .join(' · ')
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
        <Icon
          aria-hidden
          className="size-3.5 shrink-0 text-graphite"
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1 truncate mono text-micro">
          {preview.name}
        </span>
        {page === '' ? null : (
          <span className="shrink-0 mono text-micro text-graphite">{page}</span>
        )}
      </div>
      <div className="px-3 py-2.5">
        <p
          data-passage
          className="line-clamp-8 border border-rule bg-bone p-3 font-serif text-body leading-5.25 whitespace-pre-line"
        >
          {preview.text}
        </p>
      </div>
      {where === '' ? null : (
        <div className="px-3 pb-2.5 mono text-micro text-graphite">{where}</div>
      )}
    </>
  )
}

/** Wraps a citation chip with its passage on hover; any other chip as it is. */
export function RefPreview({
  refId,
  label,
  children,
}: {
  refId: string
  label: string
  children: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const loaded = useRefPreview(refId, open)
  if (!previewable(refId)) return children
  return (
    <HoverCard.Root
      open={open}
      onOpenChange={setOpen}
      openDelay={250}
      closeDelay={120}
    >
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          align="start"
          sideOffset={4}
          data-ref-preview
          className="z-dropdown flex w-85 flex-col rounded-none border border-hairline bg-paper text-foreground outline-none shadow-dither"
        >
          {loaded === undefined ? (
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate mono text-micro">
                {label}
              </span>
              <Twinkle label="Loading" />
            </div>
          ) : (
            <RefPreviewBody preview={loaded.preview} label={label} />
          )}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}
