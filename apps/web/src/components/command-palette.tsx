import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import {
  BookA,
  Boxes,
  Building2,
  Check,
  CheckSquare,
  ChevronRight,
  File,
  FileText,
  Kanban,
  Layers,
  LogOut,
  Paperclip,
  Pilcrow,
  Settings,
  Table2,
  Users,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { NAV_ITEMS } from './app-sidebar'
import { DensityRamp } from './dither'
import { SETTINGS_CRUMBS, SETTINGS_SECTIONS } from './settings/settings-nav'
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command'
import { authClient } from '#/lib/auth-client'
import { objectIcon } from '#/lib/object-icons'
import {
  GLOBAL_ACTIONS,
  latestPageAction,
  usePageActionsList,
} from '#/lib/page-actions'
import type { ActionStep, PageAction, StepChoice } from '#/lib/page-actions'
import { recordPath } from '#/lib/record-path'
import { listJumpViews, searchAll, searchPassages } from '#/lib/server-fns'
import { PictureMark } from '#/components/record/record-parts'
import type { Passage } from '#/lib/search/passages'
import type { SearchHit } from '#/lib/search/query'
import type { JumpView } from '#/lib/views/jump'
import { searchWaves } from '#/lib/search/waves'
import { cn } from '#/lib/utils'

/**
 * Cmd-K finds and goes; Ask answers. (D70)
 * - Four groups in order: Jump to, Actions, Records, Passages. A group with
 *   nothing in it is absent.
 * - Nothing typed shows only the page's own verbs (`usePageActions`), and a
 *   page with none shows only the input. Never recent items.
 * - Records is the lexical statement only, a typed name first; Passages is
 *   the semantic lane alone, a second wave once typing pauses
 *   (`searchWaves`), in its own group below.
 * - A verb with a `step` asks its answer in the same palette under its mode
 *   label; ⌫ on the empty input returns to Find with the query restored.
 * - Only our own bindings are printed: never esc, ↵ or ⌘K.
 * - cmdk's filtering is off: the server ranked these.
 */

/** A search hit, with its record's picture URL when `searchAll` found one. */
type Hit = SearchHit & { readonly picture?: string | null }

const KIND_ICONS: Record<string, LucideIcon> = {
  company: Building2,
  person: Users,
  deal: Kanban,
  space: Layers,
  note: FileText,
  document: Paperclip,
  custom: Boxes,
  term: BookA,
}

/**
 * Documents have no page — a hit lands on the record it is filed against.
 * Tasks have no page either: a task hit lands on /tasks, and selecting it
 * carries `?task=<id>` so the row takes focus.
 */
export function hrefFor(hit: Hit): string | null {
  if (hit.rowKind === 'task') return '/tasks'
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

/** Where a passage goes: its record, or the record its file is filed on. */
export function passageHref(p: Passage): string | null {
  if (p.kind === 'document') return p.parent ? recordPath(p.parent) : null
  return recordPath({ kind: p.kind, id: p.id, objectSlug: p.objectSlug })
}

/**
 * ts_headline wraps matches in « », chosen over the default <b> because the
 * snippet is rendered as text, never as HTML — extracted deck text is not
 * something to hand to a parser.
 */
export function Highlighted({ text }: { text: string }) {
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

/** A record row's path lane: where the match came from, or a task's due date. */
export function hitMeta(hit: Hit): string {
  if (hit.rowKind === 'task') return hit.task.dueDate ?? 'no date'
  if (hit.kind === 'document' && hit.parent) return `in ${hit.parent.name}`
  if (hit.matchedIn === 'name') return hit.objectSlug ?? hit.kind
  return `${hit.objectSlug ?? hit.kind} · text`
}

/** A passage's path lane: the file and its page, or the record it is on. */
export function passageMeta(p: Passage): string {
  if (p.kind === 'document')
    return p.page === null ? p.name : `${p.name} · p.${String(p.page)}`
  return `${p.objectSlug ?? p.kind} · ${p.name}`
}

/** Every row: 36px, ruled under, the selection in bone. */
const ROW = 'h-9 min-h-9 gap-3 border-b border-rule px-4 py-0'

/** The kind glyph's slot, so names start on one line. */
function Glyph({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <Icon
      aria-hidden
      className="size-3.5 shrink-0 text-graphite"
      strokeWidth={1.75}
    />
  )
}

/** The row's right lanes: the path in graphite, then the printed key. */
function Lanes({ meta, keys }: { meta?: string; keys?: string }) {
  return (
    <>
      {meta ? (
        <span className="max-w-[45%] shrink-0 truncate mono text-micro text-graphite">
          {meta}
        </span>
      ) : null}
      {keys ? (
        <kbd data-key className="shrink-0 mono text-micro text-graphite">
          {keys}
        </kbd>
      ) : null}
    </>
  )
}

/**
 * A record row's content: the kind glyph (or the record's picture), the
 * name in ink, the path in graphite. A task is struck through once done.
 */
export function HitLine({ hit }: { hit: Hit }) {
  const icon =
    hit.rowKind === 'task' ? CheckSquare : (KIND_ICONS[hit.kind] ?? FileText)
  const done = hit.rowKind === 'task' && hit.task.done
  return (
    <>
      {hit.rowKind === 'entity' && hit.picture ? (
        <PictureMark src={hit.picture} size={14} />
      ) : (
        <Glyph icon={icon} />
      )}
      <span
        className={cn(
          'min-w-0 shrink truncate',
          done && 'text-graphite line-through',
        )}
      >
        {hit.name || 'Untitled'}
      </span>
      <span className="min-w-0 flex-1 truncate text-label text-graphite">
        {hit.snippet ? <Highlighted text={hit.snippet} /> : null}
      </span>
      <Lanes meta={hitMeta(hit)} />
    </>
  )
}

/** One Jump to destination: an object, a saved view, a page or settings. */
export type JumpTarget = {
  readonly id: string
  readonly label: string
  readonly meta: string
  readonly href: string
  readonly key?: string
  readonly icon: LucideIcon
}

type CustomObject = { slug: string; plural: string; icon: string | null }

/** Every Jump to destination, in the chassis's own order. */
export function jumpTargets(
  objects: ReadonlyArray<CustomObject>,
  views: ReadonlyArray<JumpView>,
): Array<JumpTarget> {
  return [
    ...NAV_ITEMS.map((item): JumpTarget => ({
      id: `nav:${item.to}`,
      label: item.label,
      meta: item.group === 'objects' ? 'object' : 'page',
      href: item.to,
      key: item.key,
      icon: item.icon,
    })),
    ...objects.map((o): JumpTarget => ({
      id: `object:${o.slug}`,
      label: o.plural,
      meta: 'object',
      href: `/o/${o.slug}`,
      icon: objectIcon(o),
    })),
    ...views.map((v): JumpTarget => ({
      id: `view:${v.id}`,
      label: v.name,
      meta: `view · ${v.objectPlural}`,
      href: `${v.path}?view=${v.id}`,
      icon: Table2,
    })),
    {
      id: 'settings',
      label: 'Settings',
      meta: 'settings',
      href: '/settings',
      key: 'G ,',
      icon: Settings,
    },
    ...SETTINGS_SECTIONS.map((s): JumpTarget => ({
      id: `settings:${s.to}`,
      label: s.label,
      meta: `settings · ${SETTINGS_CRUMBS[s.group]}`,
      href: s.to,
      icon: Settings,
    })),
  ]
}

/** Every typed word starts some word of `text`. */
export function matchesQuery(query: string, text: string): boolean {
  const words = text.toLowerCase().split(/[\s…›·,&/]+/)
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((q) => words.some((w) => w.startsWith(q)))
}

const actionText = (a: PageAction) => `${a.label} ${a.words ?? ''}`

type Mode =
  | { readonly kind: 'find' }
  | {
      readonly kind: 'step'
      readonly step: ActionStep
      /** The Find query, restored by ⌫ on the empty input. */
      readonly findQuery: string
    }

export type PaletteBodyProps = {
  /** The mounted page's own verbs, record verbs first. */
  pageActions: ReadonlyArray<PageAction>
  /** Verbs offered on every page, once something is typed. */
  extraActions: ReadonlyArray<PageAction>
  jump: ReadonlyArray<JumpTarget>
  searchRecords: (q: string) => Promise<ReadonlyArray<Hit>>
  searchPassages: (q: string) => Promise<ReadonlyArray<Passage>>
  onGo: (href: string) => void
  onTask: (id: string) => void
  onRun: (action: PageAction) => void
  /** A step's pick was written; the page under the palette refreshes. */
  onStepDone: () => void
}

/**
 * The palette's input, groups and foot — everything inside the window, so
 * it mounts fresh on every opening and a test can mount it in a `Command`.
 */
export function PaletteBody({
  pageActions,
  extraActions,
  jump,
  searchRecords,
  searchPassages: searchPassagesFn,
  onGo,
  onTask,
  onRun,
  onStepDone,
}: PaletteBodyProps) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>({ kind: 'find' })
  const [records, setRecords] = useState<ReadonlyArray<Hit>>([])
  const [recordsFor, setRecordsFor] = useState<string | null>(null)
  const [passages, setPassages] = useState<ReadonlyArray<Passage>>([])
  const [passagesPending, setPassagesPending] = useState(false)
  const [passagesFor, setPassagesFor] = useState<string | null>(null)
  const [choices, setChoices] = useState<ReadonlyArray<StepChoice> | null>(null)
  // One scheduler per opening; the setters it closes over are stable.
  const [waves] = useState(() =>
    searchWaves<
      { q: string; rows: ReadonlyArray<Hit> },
      { q: string; rows: ReadonlyArray<Passage> }
    >({
      lexical: {
        fetch: async (q) => ({ q, rows: await searchRecords(q) }),
        show: ({ q, rows }) => {
          setRecords(rows)
          setRecordsFor(q)
        },
        fail: () => {
          setRecords([])
          setRecordsFor(null)
        },
      },
      semantic: {
        fetch: async (q) => ({ q, rows: await searchPassagesFn(q) }),
        show: ({ q, rows }) => {
          setPassages(rows)
          setPassagesPending(false)
          setPassagesFor(q)
        },
        fail: () => {
          setPassages([])
          setPassagesPending(false)
          setPassagesFor(null)
        },
      },
      start: (wave) => {
        if (wave === 'semantic') setPassagesPending(true)
      },
    }),
  )
  useEffect(() => () => waves.stop(), [waves])

  const finding = mode.kind === 'find'
  const typed = query.trim()

  /** Find asks for `next`; passages belong to the query that asked for them. */
  function find(next: string) {
    waves.type(next)
    setPassages([])
    setPassagesPending(false)
    setPassagesFor(null)
    if (next.trim().length < 2) {
      setRecords([])
      setRecordsFor(null)
    }
  }

  function onQuery(next: string) {
    setQuery(next)
    if (finding) find(next)
  }

  function startStep(step: ActionStep) {
    waves.stop()
    setMode({ kind: 'step', step, findQuery: query })
    setQuery('')
    setChoices(null)
    step.choices().then(setChoices, () => setChoices([]))
  }

  function backToFind() {
    if (mode.kind !== 'step') return
    const restored = mode.findQuery
    setMode({ kind: 'find' })
    setChoices(null)
    setQuery(restored)
    find(restored)
  }

  async function pick(step: ActionStep, choice: StepChoice) {
    if (choice.done) return
    let now: StepChoice
    try {
      now = await step.pick(choice)
    } catch {
      return
    }
    setChoices((prev) =>
      prev === null ? prev : prev.map((c) => (c.id === now.id ? now : c)),
    )
    onStepDone()
  }

  function act(action: PageAction) {
    if ('step' in action) startStep(action.step)
    else onRun(action)
  }

  // Find: nothing typed is the page's own verbs and nothing else.
  const pageIds = new Set(pageActions.map((a) => a.id))
  const actions = !typed
    ? pageActions
    : [
        ...pageActions,
        ...extraActions.filter((a) => !pageIds.has(a.id)),
      ].filter((a) => matchesQuery(typed, actionText(a)))
  const jumps = typed
    ? jump.filter((j) => matchesQuery(typed, `${j.label} ${j.meta}`))
    : []
  const shownRecords = typed.length >= 2 ? records : []
  const shownPassages = typed.length >= 2 ? passages : []
  // Nothing found waits for both waves, so a late passage never follows it.
  const settled =
    typed.length < 2 || (recordsFor === typed && passagesFor === typed)
  const nothingFound =
    typed !== '' &&
    jumps.length === 0 &&
    actions.length === 0 &&
    shownRecords.length === 0 &&
    shownPassages.length === 0 &&
    settled

  const stepChoices =
    mode.kind === 'step' && choices !== null
      ? choices.filter((c) => !typed || matchesQuery(typed, c.label))
      : []

  return (
    <>
      <CommandInput
        mode={
          finding ? (
            <span data-mode className="stamp">
              Find
            </span>
          ) : (
            <span data-mode className="stamp-outline stamp">
              {mode.step.mode} ›
            </span>
          )
        }
        aside={finding ? undefined : mode.step.subject}
        placeholder={
          finding ? 'Find a record, a page, an action' : mode.step.placeholder
        }
        value={query}
        onValueChange={onQuery}
        onKeyDown={(e) => {
          if (e.key === 'Backspace' && !finding && query === '') {
            e.preventDefault()
            backToFind()
          }
        }}
      />
      <CommandList className="max-h-[420px] p-0">
        {mode.kind === 'step' ? (
          stepChoices.length > 0 ? (
            <PaletteGroup
              id="step"
              heading={mode.step.heading}
              count={stepChoices.length}
            >
              {stepChoices.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`choice:${c.id}`}
                  onSelect={() => void pick(mode.step, c)}
                  className={cn(ROW, c.done && 'text-graphite')}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    {c.done ? (
                      <Check
                        aria-hidden
                        className="size-3.5 text-graphite"
                        strokeWidth={1.75}
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <Lanes {...(c.meta ? { meta: c.meta } : {})} />
                </CommandItem>
              ))}
            </PaletteGroup>
          ) : choices !== null ? (
            <NothingFound />
          ) : null
        ) : (
          <>
            {jumps.length > 0 ? (
              <PaletteGroup id="jump" heading="Jump to" count={jumps.length}>
                {jumps.map((j) => (
                  <CommandItem
                    key={j.id}
                    value={`jump:${j.id}`}
                    onSelect={() => onGo(j.href)}
                    className={ROW}
                  >
                    <Glyph icon={j.icon} />
                    <span className="min-w-0 flex-1 truncate">{j.label}</span>
                    <Lanes meta={j.meta} {...(j.key ? { keys: j.key } : {})} />
                  </CommandItem>
                ))}
              </PaletteGroup>
            ) : null}
            {actions.length > 0 ? (
              <PaletteGroup
                id="actions"
                heading="Actions"
                count={actions.length}
              >
                {actions.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={`action:${a.id}`}
                    onSelect={() => act(a)}
                    className={ROW}
                  >
                    <Glyph icon={a.icon ?? ChevronRight} />
                    <span className="min-w-0 flex-1 truncate">{a.label}</span>
                    <Lanes {...(a.key ? { keys: a.key } : {})} />
                  </CommandItem>
                ))}
              </PaletteGroup>
            ) : null}
            {shownRecords.length > 0 ? (
              <PaletteGroup
                id="records"
                heading="Records"
                count={shownRecords.length}
              >
                {shownRecords.map((hit) => {
                  const href = hrefFor(hit)
                  // Task ids and entity ids are two id spaces; the key and
                  // cmdk's value carry the row kind so they cannot collide.
                  const key = `${hit.rowKind}:${hit.id}`
                  return (
                    <CommandItem
                      key={key}
                      value={`record:${key}`}
                      disabled={!href}
                      onSelect={() =>
                        hit.rowKind === 'task'
                          ? onTask(hit.id)
                          : href && onGo(href)
                      }
                      className={ROW}
                    >
                      <HitLine hit={hit} />
                    </CommandItem>
                  )
                })}
              </PaletteGroup>
            ) : null}
            {shownPassages.length > 0 || passagesPending ? (
              <PaletteGroup
                id="passages"
                heading="Passages"
                count={shownPassages.length}
                running={passagesPending}
              >
                {shownPassages.map((p) => {
                  const href = passageHref(p)
                  return (
                    <CommandItem
                      key={p.id}
                      value={`passage:${p.id}`}
                      disabled={!href}
                      onSelect={() => href && onGo(href)}
                      className={ROW}
                    >
                      <Glyph icon={p.kind === 'note' ? Pilcrow : File} />
                      <span className="min-w-0 flex-1 truncate">
                        “{p.snippet || p.name}”
                      </span>
                      <Lanes meta={passageMeta(p)} />
                    </CommandItem>
                  )
                })}
              </PaletteGroup>
            ) : null}
            {nothingFound ? <NothingFound /> : null}
          </>
        )}
      </CommandList>
      <div
        data-foot
        className="flex h-8 items-center justify-between gap-3 border-t border-rule bg-bone px-4 mono text-micro text-graphite"
      >
        <span>{finding ? '↑↓ move' : '↑↓ move · ⌫ back to find'}</span>
        {finding ? null : (
          <span className="min-w-0 truncate">{mode.step.hint}</span>
        )}
      </div>
    </>
  )
}

function NothingFound() {
  return (
    <div className="flex h-9 items-center px-4 text-ui text-graphite">
      Nothing found
    </div>
  )
}

/**
 * A group under its 44px bone head: the caps label, then the count — or,
 * while its wave is out, the density ramp and "still looking." in place of
 * a spinner row.
 */
function PaletteGroup({
  id,
  heading,
  count,
  running = false,
  children,
}: {
  id: string
  heading: string
  count: number
  running?: boolean
  children: React.ReactNode
}) {
  return (
    <CommandGroup
      data-group={id}
      // The palette's own head: 44px of bone, ruled under. Rows rule their
      // own foot, so a later head needs no rule over it.
      className="[&_[cmdk-group-heading]]:h-11 [&_[cmdk-group-heading]]:justify-between [&_[cmdk-group-heading]]:gap-3 [&_[cmdk-group-heading]]:border-b [&_[cmdk-group-heading]]:border-rule [&_[cmdk-group-heading]]:bg-bone [&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:leading-none [&_[cmdk-group]:not([hidden])_~&]:pt-0"
      heading={
        <>
          <span>{heading}</span>
          {running ? (
            <span
              data-running
              className="flex items-center gap-2 tracking-normal normal-case"
            >
              <DensityRamp width={72} height={6} />
              still looking.
            </span>
          ) : (
            <span className="tracking-normal">{count}</span>
          )}
        </>
      }
    >
      {children}
    </CommandGroup>
  )
}

export function CommandPalette({
  open,
  onOpenChange,
  objects = [],
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Custom objects, for Jump to. */
  objects?: ReadonlyArray<CustomObject>
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const pageActions = usePageActionsList()
  const { data: views } = useQuery({
    queryKey: ['palette-jump-views'],
    queryFn: () => listJumpViews(),
    enabled: open,
    staleTime: 30_000,
  })
  const jump = useMemo(
    () => jumpTargets(objects, views ?? []),
    [objects, views],
  )

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

  const extraActions = useMemo<ReadonlyArray<PageAction>>(
    () => [
      ...GLOBAL_ACTIONS,
      {
        id: 'sign-out',
        label: 'Sign out',
        icon: LogOut,
        words: 'log out session',
        run: () => {
          void authClient.signOut().then(() => navigate({ to: '/login' }))
        },
      },
    ],
    [navigate],
  )

  function go(href: string) {
    onOpenChange(false)
    void navigate({ href })
  }

  /** A task hit lands on /tasks with its row focused. */
  function goTask(id: string) {
    onOpenChange(false)
    void navigate({ to: '/tasks', search: { task: id } })
  }

  /**
   * A verb closes the palette and runs a tick later: two Radix dialogs must
   * not overlap, or the palette's unmount lands after the next sheet has
   * mounted and takes the body's pointer-events with it.
   */
  function run(action: PageAction) {
    onOpenChange(false)
    const live = latestPageAction(action.id) ?? action
    if ('run' in live) setTimeout(live.run, 0)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Find a record, a page or an action from the keyboard"
      shouldFilter={false}
      showCloseButton={false}
    >
      <PaletteBody
        pageActions={pageActions}
        extraActions={extraActions}
        jump={jump}
        searchRecords={(q) => searchAll({ data: { q } })}
        searchPassages={(q) => searchPassages({ data: { q } })}
        onGo={go}
        onTask={goTask}
        onRun={run}
        onStepDone={() => void router.invalidate()}
      />
    </CommandDialog>
  )
}
