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
import { useCommandState } from 'cmdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { NAV_ITEMS } from './app-sidebar'
import { DensityRamp } from './dither'
import { DocumentPreview } from './document-preview'
import { PreviewPane } from './palette-preview'
import type {
  PaneAction,
  PreviewData,
  PreviewHit,
  PreviewLoaders,
  PreviewTarget,
} from './palette-preview'
import { SETTINGS_CRUMBS, SETTINGS_SECTIONS } from './settings/settings-nav'
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command'
import { authClient } from '#/lib/auth-client'
import { heldDecisions } from '#/lib/held-decisions'
import { fileInSpaceAction } from '#/lib/file-in-space'
import { objectIcon } from '#/lib/object-icons'
import {
  GLOBAL_ACTIONS,
  latestPageAction,
  usePageActionsList,
} from '#/lib/page-actions'
import type { ActionStep, PageAction, StepChoice } from '#/lib/page-actions'
import { recordPath } from '#/lib/record-path'
import {
  getDocumentPreview,
  listJumpViews,
  previewObject,
  previewPassage,
  previewRecord,
  searchAll,
  searchPassages,
} from '#/lib/server-fns'
import { PictureMark } from '#/components/record/record-parts'
import type { Passage } from '#/lib/search/passages'
import type { JumpView } from '#/lib/views/jump'
import { searchWaves } from '#/lib/search/waves'
import { openAsk } from '#/lib/ask/dock-store'
import { cn } from '#/lib/utils'

/**
 * Cmd-K finds and goes; Ask answers.
 * - Four groups in order: Jump to, Actions, Records, Passages. A group with
 *   nothing in it is absent.
 * - Nothing typed on a record or a space shows only its verbs, under
 *   `Actions · on <name>`, the subject named in the input. Anywhere else
 *   nothing typed shows only the input. Never recent items.
 * - Records is the lexical statement's records and tasks, in its name-first
 *   order. Passages is its notes and files, then the semantic lane's second
 *   wave once typing pauses (`searchWaves`): a note or a deck never sits in
 *   Records.
 * - A verb with a `step` asks its answer in the same palette under its mode
 *   label; ⌫ on the empty input returns to Find with the query restored.
 * - Highlighting a record, an object or a passage opens `PreviewPane` and
 *   widens the window; anything else runs the list full width.
 * - Only our own bindings are printed, and ↵ in the foot alone: never esc
 *   or ⌘K.
 * - cmdk's filtering is off: the server ranked these.
 */

type Hit = PreviewHit

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

/**
 * A record row's kind lane — `company · seed · Proptech › Property ops`: the
 * kind, its stage word, the first space it is filed in. A task's is its due
 * date.
 */
export function hitMeta(hit: Hit): string {
  if (hit.rowKind === 'task') return hit.task.dueDate ?? 'no date'
  const lane = hit.lane ?? null
  return [
    (lane?.singular ?? hit.kind).toLowerCase(),
    lane?.stage?.toLowerCase() ?? null,
    lane?.space ?? null,
  ]
    .filter((part) => part !== null && part !== '')
    .join(' · ')
}

/** The kinds the fused statement returns that are passages, not records. */
const PASSAGE_KINDS = new Set(['note', 'document'])

/**
 * The fused hits as the palette groups them: records and tasks under
 * Records, notes and files under Passages with their marked snippet.
 */
export function splitHits(hits: ReadonlyArray<Hit>): {
  records: Array<Hit>
  passages: Array<Passage>
} {
  const records: Array<Hit> = []
  const passages: Array<Passage> = []
  for (const hit of hits) {
    if (hit.rowKind === 'entity' && PASSAGE_KINDS.has(hit.kind))
      passages.push({
        id: hit.id,
        kind: hit.kind,
        name: hit.name,
        objectSlug: hit.objectSlug,
        snippet: hit.snippet ?? '',
        page: null,
        parent: hit.parent,
      })
    else records.push(hit)
  }
  return { records, passages }
}

/** The lexical passages, then the semantic lane's that are not already in. */
export function mergePassages(
  lexical: ReadonlyArray<Passage>,
  semantic: ReadonlyArray<Passage>,
): Array<Passage> {
  const seen = new Set(lexical.map((p) => p.id))
  return [...lexical, ...semantic.filter((p) => !seen.has(p.id))]
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
function Lanes({
  meta,
  keys,
}: {
  meta?: string | undefined
  keys?: string | undefined
}) {
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
  /** An object's slug: highlighting it previews its saved views. */
  readonly preview?: string
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
      ...(item.group === 'objects' ? { preview: item.to.slice(1) } : {}),
    })),
    ...objects.map((o): JumpTarget => ({
      id: `object:${o.slug}`,
      label: o.plural,
      meta: 'object',
      href: `/o/${o.slug}`,
      icon: objectIcon(o),
      preview: o.slug,
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

/**
 * What the highlighted row previews, from cmdk's selected value: a record,
 * an object under Jump to, or a passage. Anything else — a page, a view,
 * settings, a verb, a task — opens no pane.
 */
export function previewTarget(
  value: string,
  jumps: ReadonlyArray<JumpTarget>,
  records: ReadonlyArray<Hit>,
  passages: ReadonlyArray<Passage>,
): PreviewTarget | null {
  if (value.startsWith('jump:')) {
    const j = jumps.find((x) => `jump:${x.id}` === value)
    return j?.preview === undefined
      ? null
      : {
          kind: 'object',
          key: value,
          slug: j.preview,
          label: j.label,
          href: j.href,
        }
  }
  if (value.startsWith('record:entity:')) {
    const hit = records.find(
      (h) => h.rowKind === 'entity' && `record:entity:${h.id}` === value,
    )
    return hit ? { kind: 'record', key: value, hit } : null
  }
  if (value.startsWith('passage:')) {
    const passage = passages.find((p) => `passage:${p.id}` === value)
    return passage ? { kind: 'passage', key: value, passage } : null
  }
  return null
}

async function loadPreview(
  loaders: PreviewLoaders,
  target: PreviewTarget,
): Promise<PreviewData> {
  switch (target.kind) {
    case 'record':
      return { kind: 'record', data: await loaders.record(target.hit.id) }
    case 'object':
      return { kind: 'object', data: await loaders.object(target.slug) }
    case 'passage':
      return {
        kind: 'passage',
        data: await loaders.passage({
          id: target.passage.id,
          page: target.passage.page,
          snippet: target.passage.snippet,
        }),
      }
  }
}

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
  /** The record or space the page is on, by name; null on a page with none. */
  scope: string | null
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
  /** The preview pane's reads; each runs once per row per opening. */
  loaders: PreviewLoaders
  /** Open a file in the viewer, at a page when the passage knows it. */
  onOpenFile: (id: string, page: number | null) => void
  /** Tab: hand the typed text to Ask. The palette never answers. */
  onAsk?: ((text: string) => void) | undefined
}

/**
 * The palette's input, groups and foot — everything inside the window, so
 * it mounts fresh on every opening and a test can mount it in a `Command`.
 */
export function PaletteBody({
  pageActions,
  scope,
  extraActions,
  jump,
  searchRecords,
  searchPassages: searchPassagesFn,
  onGo,
  onTask,
  onRun,
  onStepDone,
  loaders,
  onOpenFile,
  onAsk,
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

  // Find: nothing typed is the subject's own verbs, and nothing on any other page.
  const pageIds = new Set(pageActions.map((a) => a.id))
  const actions = !typed
    ? scope === null
      ? []
      : pageActions
    : [
        ...pageActions,
        ...extraActions.filter((a) => !pageIds.has(a.id)),
      ].filter((a) => matchesQuery(typed, actionText(a)))
  const jumps = typed
    ? jump.filter((j) => matchesQuery(typed, `${j.label} ${j.meta}`))
    : []
  const fused = splitHits(typed.length >= 2 ? records : [])
  const shownRecords = fused.records
  const shownPassages = mergePassages(
    fused.passages,
    typed.length >= 2 ? passages : [],
  )
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

  // The preview pane follows the highlight; nothing previewable, no pane.
  // cmdk holds no value until a row mounts, whatever its type says.
  const selected = useCommandState((s): string | undefined => s.value)
  const target =
    finding && selected !== undefined
      ? previewTarget(selected, jumps, shownRecords, shownPassages)
      : null
  // One read per row per opening: the body mounts fresh with the window.
  const [previews, setPreviews] = useState<ReadonlyMap<string, PreviewData>>(
    () => new Map(),
  )
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (target === null || asked.current.has(target.key)) return
    const key = target.key
    asked.current.add(key)
    loadPreview(loaders, target).then(
      (data) => setPreviews((prev) => new Map(prev).set(key, data)),
      () => {},
    )
  })
  const preview = target ? previews.get(target.key) : undefined
  const pane = useRef<HTMLElement>(null)

  /** → and the foot's actions: focus the pane's first action. */
  function focusPane(): boolean {
    const first = pane.current?.querySelector<HTMLElement>('[data-pane-action]')
    first?.focus()
    return first !== undefined && first !== null
  }

  function backToList() {
    pane.current
      ?.closest('[cmdk-root]')
      ?.querySelector<HTMLInputElement>('[cmdk-input]')
      ?.focus()
  }

  function paneActions(t: PreviewTarget): Array<PaneAction> {
    if (t.kind === 'record') {
      const href = hrefFor(t.hit)
      const data = preview?.kind === 'record' ? preview.data : undefined
      const out: Array<PaneAction> = []
      if (href) out.push({ id: 'open', label: 'Open', run: () => onGo(href) })
      if (data && data.singular !== null) {
        const verb = fileInSpaceAction({
          id: data.id,
          name: data.name,
          filedIds: data.spaces.map((s) => s.id),
        })
        if ('step' in verb)
          out.push({
            id: verb.id,
            label: verb.label,
            run: () => startStep(verb.step),
          })
      }
      return out
    }
    if (t.kind === 'object') {
      const data = preview?.kind === 'object' ? preview.data : undefined
      return [
        ...(data ?? { views: [] }).views.map((v) => ({
          id: `view:${v.id}`,
          label: v.name,
          run: () => onGo(v.href),
        })),
        { id: 'open', label: `Open ${t.label}`, run: () => onGo(t.href) },
      ]
    }
    const p = t.passage
    if (p.kind === 'document')
      return [
        {
          id: 'open',
          label: p.page === null ? 'Open' : `Open at p.${String(p.page)}`,
          run: () => onOpenFile(p.id, p.page),
        },
      ]
    const href = passageHref(p)
    return href ? [{ id: 'open', label: 'Open', run: () => onGo(href) }] : []
  }

  return (
    <>
      <CommandInput
        mode={
          finding ? (
            <span data-mode className="stamp">
              Find
            </span>
          ) : (
            <span data-mode className="stamp stamp-outline">
              {mode.step.mode} ›
            </span>
          )
        }
        aside={
          finding
            ? scope === null
              ? undefined
              : `on ${scope}`
            : mode.step.subject
        }
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
          if (e.key === 'Tab' && !e.shiftKey && finding && onAsk) {
            e.preventDefault()
            onAsk(query)
          }
          // → at the end of the query moves into the pane's actions.
          if (
            e.key === 'ArrowRight' &&
            target !== null &&
            e.currentTarget.selectionStart === e.currentTarget.value.length &&
            focusPane()
          )
            e.preventDefault()
        }}
      />
      <div className="flex min-h-0">
        <CommandList className="max-h-[420px] min-w-0 flex-1 p-0">
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
                      <Lanes
                        meta={j.meta}
                        {...(j.key ? { keys: j.key } : {})}
                      />
                    </CommandItem>
                  ))}
                </PaletteGroup>
              ) : null}
              {actions.length > 0 ? (
                <PaletteGroup
                  id="actions"
                  heading={
                    !typed && scope !== null
                      ? `Actions · on ${scope}`
                      : 'Actions'
                  }
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
                      <Lanes meta={a.meta} keys={a.key} />
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
                    // A file's passage opens the viewer at its page.
                    const file = p.kind === 'document'
                    return (
                      <CommandItem
                        key={p.id}
                        value={`passage:${p.id}`}
                        disabled={!file && !href}
                        onSelect={() =>
                          file ? onOpenFile(p.id, p.page) : href && onGo(href)
                        }
                        className={ROW}
                      >
                        <Glyph icon={p.kind === 'note' ? Pilcrow : File} />
                        <span className="min-w-0 flex-1 truncate">
                          “
                          {p.snippet ? (
                            <Highlighted text={p.snippet} />
                          ) : (
                            p.name
                          )}
                          ”
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
        {target ? (
          <PreviewPane
            ref={pane}
            target={target}
            data={preview}
            actions={paneActions(target)}
            onBack={backToList}
          />
        ) : null}
      </div>
      <div
        data-foot
        className="flex h-8 items-center justify-between gap-3 border-t border-rule bg-bone px-4 mono text-micro text-graphite"
      >
        <span>
          {finding
            ? `↑↓ move · ↵ open${onAsk ? ' · tab ask' : ''}`
            : '↑↓ move · ⌫ back to find'}
          {target ? (
            <>
              {' · '}
              <button
                type="button"
                data-foot-actions
                onClick={focusPane}
                className="focus-ring hover:text-foreground"
              >
                → actions
              </button>
            </>
          ) : null}
        </span>
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
  const { actions: pageActions, scope } = usePageActionsList()
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
          // Held decisions are written as this user, so before the session goes.
          void heldDecisions
            .flush()
            .then(() => authClient.signOut())
            .then(() => navigate({ to: '/login' }))
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

  const loaders = useMemo<PreviewLoaders>(
    () => ({
      record: (id) => previewRecord({ data: { id } }),
      object: (slug) => previewObject({ data: { slug } }),
      passage: (p) => previewPassage({ data: p }),
    }),
    [],
  )

  /** The file viewer, opened once the palette has closed (as `run`). */
  const [viewer, setViewer] = useState<{
    doc: NonNullable<Awaited<ReturnType<typeof getDocumentPreview>>>
    page: number | null
  } | null>(null)

  function openFile(id: string, page: number | null) {
    onOpenChange(false)
    setTimeout(() => {
      void getDocumentPreview({ data: { id } }).then((doc) => {
        if (doc) setViewer({ doc, page })
      })
    }, 0)
  }

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Command palette"
        description="Find a record, a page or an action from the keyboard"
        shouldFilter={false}
        // The palette widens while the preview pane is open; its scrim is
        // bone-deep, never a blur.
        className="sm:has-[[data-preview]]:max-w-[66rem]"
        overlayClassName="bg-bone-deep/60"
      >
        <PaletteBody
          pageActions={pageActions}
          scope={scope}
          extraActions={extraActions}
          jump={jump}
          searchRecords={(q) => searchAll({ data: { q } })}
          searchPassages={(q) => searchPassages({ data: { q } })}
          onGo={go}
          onTask={goTask}
          onRun={run}
          onStepDone={() => void router.invalidate()}
          loaders={loaders}
          onOpenFile={openFile}
          onAsk={(text) => {
            onOpenChange(false)
            setTimeout(() => openAsk({ draft: text }), 0)
          }}
        />
      </CommandDialog>
      <DocumentPreview
        doc={viewer?.doc ?? null}
        {...(viewer?.page ? { page: viewer.page } : {})}
        onOpenChange={(next) => {
          if (!next) setViewer(null)
        }}
      />
    </>
  )
}
