import { useRef } from 'react'
import type { ReactNode } from 'react'
import { Check, icon } from '#/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { cn } from '#/lib/utils'

export type FeedsTab = 'headlines' | 'sources'

const TAB_LABEL: Record<FeedsTab, string> = {
  headlines: 'Headlines',
  sources: 'Sources',
}

const TABS: ReadonlyArray<FeedsTab> = ['headlines', 'sources']

/** Mono graphite words that are a control: ink on hover and while open. */
const WORD =
  'focus-ring flex min-w-0 items-baseline gap-1.5 rounded-none mono text-micro text-graphite hover:text-foreground data-[state=open]:text-foreground'

/**
 * The Feeds head below `md`, in place of the folder bar: one mono line on
 * the title's baseline, `Headlines · All spaces`.
 * - The tab's name opens the page's tabs, the open one checked, Sources with
 *   its count and the failing square; then `Add feed…`, since the head's
 *   button is not drawn at this width. It opens the window once the menu
 *   has let go of focus, so focus is not handed back to the trigger.
 * - `scope` is the space filter's `line` picker, after a `·`; absent (on
 *   Sources, or with no space to narrow to) the line is the tab alone.
 */
export function FeedsHeadLine({
  tab,
  onTab,
  sourceCount,
  failing,
  onAdd,
  scope,
  className,
}: {
  tab: FeedsTab
  onTab: (tab: FeedsTab) => void
  sourceCount: number
  failing: boolean
  onAdd: () => void
  scope?: ReactNode
  className?: string | undefined
}) {
  const adding = useRef(false)
  return (
    <div
      data-feeds-head-line
      className={cn('flex min-w-0 items-baseline gap-1.5', className)}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`View: ${TAB_LABEL[tab]}${failing ? ', a feed is failing' : ''}`}
          className={WORD}
        >
          {TAB_LABEL[tab]}
          {failing ? (
            <span
              aria-hidden
              data-failing-mark
              className="size-1.5 shrink-0 self-center bg-destructive"
            />
          ) : null}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-44"
          onCloseAutoFocus={(e) => {
            if (!adding.current) return
            e.preventDefault()
            adding.current = false
            onAdd()
          }}
        >
          {TABS.map((id) => (
            <DropdownMenuItem
              key={id}
              role="menuitemradio"
              aria-checked={id === tab}
              onSelect={() => onTab(id)}
            >
              <span aria-hidden className="flex size-4 shrink-0">
                {id === tab ? <Check className="size-4" /> : null}
              </span>
              {TAB_LABEL[id]}
              {id === 'sources' ? (
                <span className="ml-auto flex items-center gap-1.5 pl-3">
                  {failing ? (
                    <span
                      role="img"
                      aria-label="A feed is failing"
                      className="size-1.5 shrink-0 bg-destructive"
                    />
                  ) : null}
                  <span className="mono text-micro text-graphite">
                    {sourceCount}
                  </span>
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              adding.current = true
            }}
          >
            <icon.new aria-hidden className="size-4" />
            Add feed…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {scope === undefined ? null : (
        <>
          <span aria-hidden className="mono text-micro text-graphite">
            ·
          </span>
          {scope}
        </>
      )}
    </div>
  )
}
