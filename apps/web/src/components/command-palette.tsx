import { useNavigate } from '@tanstack/react-router'
import {
  Boxes,
  Building2,
  FileText,
  Kanban,
  Layers,
  LogOut,
  Paperclip,
  Settings,
  Upload,
  Users,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { NAV_ITEMS } from './app-sidebar'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command'
import { authClient } from '#/lib/auth-client'
import { recordPath } from '#/lib/record-path'
import { searchAll } from '#/lib/server-fns'
import { openUploadDialog } from '#/lib/upload-dialog-store'

/**
 * Cmd-K over everything: names, note bodies, and extracted document text,
 * fused and ranked in Postgres (see searchAll). cmdk's own filtering is off
 * — the server already ranked these, and re-filtering client-side would drop
 * the typo matches trigram search exists to catch.
 */

type Hit = Awaited<ReturnType<typeof searchAll>>[number]

const KIND_ICONS: Record<string, LucideIcon> = {
  company: Building2,
  person: Users,
  deal: Kanban,
  space: Layers,
  note: FileText,
  document: Paperclip,
  custom: Boxes,
}

/** Documents have no page — a hit lands on the record it is filed against. */
function hrefFor(hit: Hit): string | null {
  const target =
    hit.kind === 'document'
      ? hit.parent
        ? {
            kind: hit.parent.kind,
            id: hit.parent.id,
            objectSlug: hit.parent.objectSlug,
          }
        : null
      : { kind: hit.kind, id: hit.id, objectSlug: hit.objectSlug }
  if (!target) return null
  return recordPath(target)
}

/**
 * ts_headline wraps matches in « », chosen over the default <b> because the
 * snippet is rendered as text, never as HTML — extracted deck text is not
 * something to hand to a parser.
 */
function Highlighted({ text }: { text: string }) {
  return (
    <>
      {text.split(/(«[^»]*»)/).map((part, i) =>
        part.startsWith('«') && part.endsWith('»') ? (
          <span key={i} className="font-medium text-foreground">
            {part.slice(1, -1)}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

/**
 * The palette's **actions** — commands that do something where every other
 * row goes somewhere (SPA-108). Declared as data for the same reason
 * `NAV_ITEMS` is: the next action is one row here and no edit to either
 * branch below, and the group draws itself in both.
 *
 * They survive search mode, matched locally on their own words, because
 * “upload” typed into the palette is an intention and not a search for the
 * word — the server's ranking has nothing to say about a command that is not
 * a row in any table.
 */
type PaletteAction = {
  value: string
  label: string
  icon: LucideIcon
  /** Extra words the local match reads — never drawn. */
  words: string
  run: () => void
}

const ACTIONS: Array<PaletteAction> = [
  {
    value: 'upload',
    label: 'Upload a file…',
    icon: Upload,
    words: 'upload file document deck attach drop',
    run: openUploadDialog,
  },
]

/** Prefix match on any of an action's words — cmdk's filter is off here. */
export function matchingActions(query: string): Array<PaletteAction> {
  const q = query.trim().toLowerCase()
  if (!q) return ACTIONS
  return ACTIONS.filter((a) =>
    `${a.label.toLowerCase()} ${a.words}`
      .split(/[\s…]+/)
      .some((w) => w.startsWith(q)),
  )
}

function ActionsGroup({
  actions,
  onRun,
}: {
  actions: Array<PaletteAction>
  onRun: (action: PaletteAction) => void
}) {
  if (actions.length === 0) return null
  return (
    <CommandGroup heading="Actions">
      {actions.map((action) => (
        <CommandItem
          key={action.value}
          value={action.value}
          onSelect={() => onRun(action)}
        >
          <action.icon className="size-3.5" strokeWidth={1.75} />
          {action.label}
          <span data-hint className="ml-auto mono text-micro text-graphite">
            ↵
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Array<Hit>>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  // Reset between openings — reopening onto a stale result list reads as a bug.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setHits([])
      setSearching(false)
    }
  }, [open])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const rows = await searchAll({ data: { q } })
          // Out-of-order responses would otherwise show results for a query the
          // user has already typed past.
          if (!cancelled) setHits(rows)
        } catch {
          if (!cancelled) setHits([])
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  function go(to: string) {
    onOpenChange(false)
    void navigate({ to })
  }

  /**
   * An action closes the palette and then runs, a tick later: two Radix
   * dialogs must not overlap, or the palette's unmount lands after the next
   * sheet has mounted and takes the body's pointer-events with it.
   */
  function run(action: PaletteAction) {
    onOpenChange(false)
    setTimeout(action.run, 0)
  }

  const searchMode = query.trim().length >= 2
  const matched = matchingActions(query)

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search and navigate from the keyboard"
      shouldFilter={false}
      showCloseButton={false}
    >
      <CommandInput
        placeholder="Search or jump to…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {searchMode ? (
          <>
            {/* An action outranks a hit: “upload” typed into the palette is
                an intention to upload, not a search for the word. */}
            <ActionsGroup actions={matched} onRun={run} />
            {hits.length === 0 ? (
              matched.length > 0 ? null : (
                <CommandEmpty>
                  {searching
                    ? 'Searching…'
                    : `Nothing matches “${query.trim()}”.`}
                </CommandEmpty>
              )
            ) : (
              <CommandGroup heading={`Results · ${hits.length}`}>
                {hits.map((hit) => {
                  const Icon = KIND_ICONS[hit.kind] ?? FileText
                  const href = hrefFor(hit)
                  return (
                    <CommandItem
                      key={hit.id}
                      value={hit.id}
                      disabled={!href}
                      onSelect={() => href && go(href)}
                      className="items-start gap-2.5"
                    >
                      <Icon
                        className="mt-0.5 size-4 shrink-0 text-graphite"
                        strokeWidth={1.75}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 truncate">
                            {hit.name || 'Untitled'}
                          </span>
                          {/* Where the match came from, because "why is this
                              here" is the first question a fuzzy hit raises. */}
                          <span className="shrink-0 mono text-micro text-graphite">
                            {hit.kind === 'document' && hit.parent
                              ? `in ${hit.parent.name}`
                              : hit.matchedIn === 'name'
                                ? (hit.objectSlug ?? hit.kind)
                                : `${hit.objectSlug ?? hit.kind} · text`}
                          </span>
                        </span>
                        {hit.snippet ? (
                          <span className="mt-0.5 block truncate text-label text-graphite">
                            <Highlighted text={hit.snippet} />
                          </span>
                        ) : null}
                      </span>
                      <span data-hint className="mono text-micro text-graphite">
                        ↵
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
          </>
        ) : (
          <>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup heading="Go to">
              {NAV_ITEMS.map((item) => (
                <CommandItem
                  key={item.to}
                  value={item.to}
                  onSelect={() => go(item.to)}
                >
                  <item.icon className="size-3.5" strokeWidth={1.75} />
                  {item.label}
                  <span
                    data-hint
                    className="ml-auto mono text-micro text-graphite"
                  >
                    ↵
                  </span>
                </CommandItem>
              ))}
              <CommandItem value="/settings" onSelect={() => go('/settings')}>
                <Settings className="size-3.5" strokeWidth={1.75} />
                Settings
                <span
                  data-hint
                  className="ml-auto mono text-micro text-graphite"
                >
                  ↵
                </span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <ActionsGroup actions={ACTIONS} onRun={run} />
            <CommandSeparator />
            <CommandGroup heading="Session">
              <CommandItem
                value="sign-out"
                onSelect={async () => {
                  onOpenChange(false)
                  await authClient.signOut()
                  void navigate({ to: '/login' })
                }}
              >
                <LogOut className="size-3.5" strokeWidth={1.75} />
                Sign out
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
      <div className="flex h-8 items-center justify-between border-t border-rule bg-bone px-4 mono text-micro text-graphite">
        <span>
          {searchMode
            ? searching
              ? 'searching…'
              : `${hits.length} result${hits.length === 1 ? '' : 's'}`
            : 'type to search everything'}
        </span>
        <span>esc</span>
      </div>
    </CommandDialog>
  )
}
