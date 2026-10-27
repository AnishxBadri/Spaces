import {
  BookA,
  Boxes,
  Building2,
  File,
  FileText,
  Kanban,
  Layers,
  Paperclip,
  Pilcrow,
  Users,
} from 'lucide-react'
import { forwardRef } from 'react'
import type { KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { formatDay } from '@spaces/core/format'
import { fmtPct } from '@spaces/core/portfolio/format'
import { useClock } from './clock'
import { Twinkle } from './twinkle'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { PictureMark, PreviewHead } from './record/record-parts'
import type { RecordReadout } from './record/record-parts'
import { DASH, readoutDay } from '#/lib/records/readout-format'
import type { KindLane } from '#/lib/search/kind-lanes'
import type { Passage } from '#/lib/search/passages'
import type {
  ObjectPreview,
  PassagePreview,
  PreviewReadouts,
  RecordPreview,
} from '#/lib/search/preview'
import type { SearchHit } from '#/lib/search/query'
import { cn } from '#/lib/utils'

/**
 * Cmd-K's preview pane: the highlighted result, right of the list. Always
 * mounted, and blank bone when nothing previewable is highlighted.
 * - A record: its stamp, glyph and name, a company's domain, the double
 *   rule, its readouts two-up (only those with a value), then its first six
 *   filled attributes as a label grid.
 * - An object: its glyph and name, `All` with the record total, then its
 *   saved views with their counts.
 * - A passage: its file and page, the page's context with the match set off
 *   in serif, and the record it is filed on with its day.
 * - → from the input focuses the pane's actions; ↑↓ moves among them and
 *   ← returns to the list.
 */

/** A search hit, with its picture URL and kind lane when `searchAll` has them. */
export type PreviewHit = SearchHit & {
  readonly picture?: string | null
  readonly lane?: KindLane | null
}

/** What the highlighted row asks the pane to show, keyed by the row's value. */
export type PreviewTarget =
  | { readonly kind: 'record'; readonly key: string; readonly hit: PreviewHit }
  | {
      readonly kind: 'object'
      readonly key: string
      readonly slug: string
      readonly label: string
      readonly icon: LucideIcon
      /** The object's list. */
      readonly href: string
    }
  | {
      readonly kind: 'passage'
      readonly key: string
      readonly passage: Passage
    }

/** The pane's reads, one per highlighted row per opening. */
export type PreviewLoaders = {
  readonly record: (id: string) => Promise<RecordPreview>
  readonly object: (slug: string) => Promise<ObjectPreview | null>
  readonly passage: (p: {
    id: string
    page: number | null
    snippet: string
  }) => Promise<PassagePreview>
}

export type PreviewData =
  | { readonly kind: 'record'; readonly data: RecordPreview }
  | { readonly kind: 'object'; readonly data: ObjectPreview | null }
  | { readonly kind: 'passage'; readonly data: PassagePreview }

/** One verb on the highlighted result. */
export type PaneAction = {
  readonly id: string
  readonly label: string
  readonly run: () => void
}

/** Each kind's glyph, in the list and in the pane alike. */
export const KIND_ICONS: Record<string, LucideIcon> = {
  company: Building2,
  person: Users,
  deal: Kanban,
  space: Layers,
  note: FileText,
  document: Paperclip,
  custom: Boxes,
  term: BookA,
}

/** The record head's readouts, as each record page prints them. */
export function previewReadouts(r: PreviewReadouts): Array<RecordReadout> {
  switch (r.kind) {
    case 'company':
      return [
        {
          label: 'Last contact',
          value: readoutDay(r.readouts.lastContact, r.readouts.today),
        },
        {
          label: 'Moving, 30 days',
          value: `${r.readouts.moving30}`,
          tone: r.readouts.moving30 === 0 ? 'muted' : undefined,
        },
        {
          label: 'Ownership',
          value: !r.readouts.ownership
            ? DASH
            : r.readouts.ownership.kind === 'implied'
              ? `~${fmtPct(r.readouts.ownership.pct)}`
              : fmtPct(r.readouts.ownership.pct),
        },
      ]
    case 'person':
      return [
        {
          label: 'Last contact',
          value: readoutDay(r.readouts.lastContact, r.readouts.today),
        },
        {
          label: 'Last email',
          value: readoutDay(r.readouts.lastEmail, r.readouts.today),
        },
        {
          label: 'First contact',
          value: readoutDay(r.readouts.firstContact, r.readouts.today),
        },
      ]
    case 'deal':
      return [
        {
          label: 'Days in stage',
          value:
            r.readouts.medianDaysInStage === null
              ? `${r.readouts.daysInStage}`
              : `${r.readouts.daysInStage} · med ${Math.round(r.readouts.medianDaysInStage)}`,
          tone: r.readouts.pastTwiceMedian ? 'bad' : undefined,
        },
        {
          label: 'Last contact',
          value: readoutDay(r.readouts.lastContact, r.readouts.today),
        },
      ]
    case 'custom':
      return [
        {
          label: 'Last contact',
          value: readoutDay(r.readouts.lastContact, r.readouts.today),
        },
        {
          label: 'Moving, 30 days',
          value: `${r.readouts.moving30}`,
          tone: r.readouts.moving30 === 0 ? 'muted' : undefined,
        },
      ]
  }
}

/** The readouts the pane prints: a dash says nothing, so it is left out. */
export function filledReadouts(r: PreviewReadouts): Array<RecordReadout> {
  return previewReadouts(r).filter(
    (x) => typeof x.value !== 'string' || (x.value !== DASH && x.value !== ''),
  )
}

/** `Page 4 of 9`, or `Page 4` before the file's length is known. */
export function pageOf(page: number | null, pages: number | null): string {
  if (page === null) return ''
  return pages === null
    ? `Page ${String(page)}`
    : `Page ${String(page)} of ${String(pages)}`
}

const KIND_LABELS: Partial<Record<string, string>> = {
  note: 'Note',
  document: 'File',
  space: 'Space',
  term: 'Term',
}

const ACTION = '[data-pane-action]'

/** ↑↓ among the pane's actions, ← back to the list; kept from cmdk's root. */
function onPaneKeyDown(e: KeyboardEvent<HTMLElement>, onBack: () => void) {
  const actions = [...e.currentTarget.querySelectorAll<HTMLElement>(ACTION)]
  const at = actions.findIndex((a) => a === document.activeElement)
  const move = (to: number) => {
    e.preventDefault()
    e.stopPropagation()
    actions.at(Math.max(0, Math.min(actions.length - 1, to)))?.focus()
  }
  if (e.key === 'ArrowDown') move(at + 1)
  else if (e.key === 'ArrowUp') move(at - 1)
  else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    e.stopPropagation()
    onBack()
  } else if (e.key === 'Enter' || e.key === 'Home' || e.key === 'End') {
    // cmdk's root would take these for the list; the focused button keeps them.
    e.stopPropagation()
  }
}

type PaneProps = {
  /** Null: nothing previewable is highlighted, and the pane is blank. */
  target: PreviewTarget | null
  data: PreviewData | undefined
  actions: ReadonlyArray<PaneAction>
  onBack: () => void
}

/**
 * The pane: 40% of the window, 280 to 420px, bone, ruled off by a hairline.
 * It never unmounts, so the list beside it never changes width.
 */
export const PreviewPane = forwardRef<HTMLElement, PaneProps>(
  function PreviewPane({ target, data, actions, onBack }, ref) {
    return (
      <aside
        ref={ref}
        data-preview={target?.kind ?? 'none'}
        aria-label="Preview"
        onKeyDown={(e) => onPaneKeyDown(e, onBack)}
        className="flex max-w-[420px] min-w-[280px] shrink-0 basis-[40%] flex-col overflow-y-auto border-l border-hairline bg-bone"
      >
        {target === null ? null : target.kind === 'record' ? (
          <RecordPane
            hit={target.hit}
            data={data?.kind === 'record' ? data.data : undefined}
            actions={actions}
          />
        ) : target.kind === 'object' ? (
          <ObjectPane
            label={target.label}
            icon={target.icon}
            data={data?.kind === 'object' ? data.data : undefined}
            actions={actions}
          />
        ) : (
          <PassagePane
            passage={target.passage}
            data={data?.kind === 'passage' ? data.data : undefined}
            actions={actions}
          />
        )}
      </aside>
    )
  },
)

function Actions({ actions }: { actions: ReadonlyArray<PaneAction> }) {
  if (actions.length === 0) return null
  return (
    <div
      data-pane-actions
      className="mt-auto flex flex-wrap gap-2 border-t border-rule px-5 py-3"
    >
      {actions.map((a) => (
        <Button
          key={a.id}
          type="button"
          size="sm"
          variant="outline"
          data-pane-action={a.id}
          onClick={a.run}
        >
          {a.label}
        </Button>
      ))}
    </div>
  )
}

function Glyph({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <Icon aria-hidden className="size-3.5 text-graphite" strokeWidth={1.75} />
    </span>
  )
}

function RecordPane({
  hit,
  data,
  actions,
}: {
  hit: PreviewHit
  data: RecordPreview | undefined
  actions: ReadonlyArray<PaneAction>
}) {
  const readouts = data?.readouts ? filledReadouts(data.readouts) : []
  return (
    <>
      <PreviewHead
        stamp={data?.singular ?? KIND_LABELS[hit.kind] ?? hit.kind}
        mark={
          hit.picture ? (
            <PictureMark src={hit.picture} size={16} />
          ) : (
            <Glyph icon={KIND_ICONS[hit.kind] ?? FileText} />
          )
        }
        name={data?.name ?? hit.name}
        working={data === undefined}
      >
        {data?.domain ? (
          <span data-domain className="truncate mono text-micro text-graphite">
            {data.domain}
          </span>
        ) : null}
      </PreviewHead>
      {readouts.length > 0 ? (
        <div data-readouts className="grid grid-cols-2 border-b border-rule">
          {readouts.map((r, i) => (
            <div
              key={i}
              className="flex min-w-0 flex-col gap-0.5 border-r border-b border-rule px-5 py-2 even:border-r-0"
            >
              <span
                className={cn(
                  'truncate mono text-title',
                  r.tone === 'bad' && 'text-destructive',
                  r.tone === 'muted' && 'text-graphite',
                )}
              >
                {r.value}
              </span>
              <span className="truncate text-label text-graphite">
                {r.label}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {data && data.fields.length > 0 ? (
        <dl className="mt-3 flex flex-col border-t border-rule">
          {data.fields.map((f) => (
            <div
              key={f.slug}
              data-field={f.slug}
              className="grid min-h-7.5 grid-cols-[112px_1fr] border-b border-rule"
            >
              <dt className="flex items-center truncate bg-bone px-5 text-label text-graphite">
                {f.label}
              </dt>
              <dd className="flex min-w-0 items-center border-l border-rule bg-paper px-3">
                {f.display === 'badge' ? (
                  <Badge option={f.option} index={f.index}>
                    {f.value}
                  </Badge>
                ) : (
                  <span
                    className={cn(
                      'truncate',
                      f.display === 'money' ? 'mono text-label' : 'text-ui',
                    )}
                  >
                    {f.value}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Actions actions={actions} />
    </>
  )
}

function ObjectPane({
  label,
  icon,
  data,
  actions,
}: {
  label: string
  icon: LucideIcon
  data: ObjectPreview | null | undefined
  actions: ReadonlyArray<PaneAction>
}) {
  const rows =
    data === null || data === undefined
      ? []
      : [
          { id: 'all', name: 'All', count: data.total },
          ...data.views.map((v) => ({
            id: `view:${v.id}`,
            name: v.name,
            count: v.count,
          })),
        ]
  return (
    <>
      <PreviewHead
        mark={<Glyph icon={icon} />}
        name={data?.plural ?? label}
        working={data === undefined}
      />
      {rows.length > 0 ? (
        <ul className="flex flex-col">
          {rows.map((v) => {
            const run = actions.find((a) => a.id === v.id)?.run
            return (
              <li key={v.id}>
                <button
                  type="button"
                  data-pane-action={v.id}
                  data-view={v.id}
                  onClick={run}
                  className="flex h-row w-full items-center gap-3 border-b border-rule px-5 text-left text-ui outline-none hover:bg-paper focus-visible:bg-selected"
                >
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  <span
                    className={cn(
                      'shrink-0 mono text-micro',
                      v.count === null && 'text-graphite',
                    )}
                  >
                    {v.count === null ? DASH : v.count}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <Actions
        actions={actions.filter(
          (a) => a.id !== 'all' && !a.id.startsWith('view:'),
        )}
      />
    </>
  )
}

function PassagePane({
  passage,
  data,
  actions,
}: {
  passage: Passage
  data: PassagePreview | undefined
  actions: ReadonlyArray<PaneAction>
}) {
  const { today } = useClock()
  const Icon = passage.kind === 'document' ? File : Pilcrow
  // Until the page arrives, the snippet the row carries stands in for it.
  const parts =
    data && data.parts.length > 0
      ? data.parts
      : [
          {
            text: passage.snippet.replace(/[«»]/g, '') || passage.name,
            matched: true,
          },
        ]
  const page = pageOf(passage.page, data?.pages ?? null)
  const on = data?.on?.name ?? passage.parent?.name ?? null
  const dayIso = data?.day ?? passage.day
  const day = dayIso === null ? '' : formatDay(dayIso, today)
  const where = [on === null ? null : `On ${on}`, day || null]
    .filter((x) => x !== null)
    .join(' · ')
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-5 pt-4">
        <Icon
          aria-hidden
          className="size-3.5 shrink-0 text-graphite"
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1 truncate mono text-micro">
          {passage.name}
        </span>
        {page ? (
          <span data-page-of className="shrink-0 mono text-micro text-graphite">
            {page}
          </span>
        ) : null}
        {data === undefined ? <Twinkle label="Loading" /> : null}
      </div>
      <div data-page className="flex flex-col gap-2 px-5 py-3">
        {parts.map((part, i) =>
          part.matched ? (
            <p
              key={i}
              data-matched
              className="border border-rule bg-paper p-3 font-serif text-body whitespace-pre-line"
            >
              {part.text}
            </p>
          ) : (
            <p key={i} className="text-label whitespace-pre-line text-graphite">
              {part.text}
            </p>
          ),
        )}
      </div>
      {where ? (
        <div data-on className="px-5 pb-3 mono text-micro text-graphite">
          {where}
        </div>
      ) : null}
      <Actions actions={actions} />
    </>
  )
}
