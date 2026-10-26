import { File, Pilcrow } from 'lucide-react'
import { forwardRef } from 'react'
import type { KeyboardEvent } from 'react'
import { fmtPct } from '@spaces/core/portfolio/format'
import { Button } from './ui/button'
import { PictureMark, PreviewHead, ReadoutStrip } from './record/record-parts'
import type { RecordReadout } from './record/record-parts'
import { DASH, readoutDay, readoutDayAgo } from '#/lib/records/readout-format'
import type { KindLane } from '#/lib/search/kind-lanes'
import type { Passage } from '#/lib/search/passages'
import type {
  ObjectPreview,
  PassagePreview,
  PreviewReadouts,
  RecordPreview,
} from '#/lib/search/preview'
import type { SearchHit } from '#/lib/search/query'

/**
 * Cmd-K's preview pane: the highlighted result, right of the list.
 * - A record: its stamp, name and readout strip, then its first
 *   six filled attributes as label–value rows.
 * - An object: its saved views with their counts.
 * - A passage: its page's text, the matched chunk set off.
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

/** The record head's readouts, as each record page prints them. */
export function previewReadouts(r: PreviewReadouts): Array<RecordReadout> {
  switch (r.kind) {
    case 'company':
      return [
        {
          label: 'Last contact',
          value: readoutDayAgo(r.readouts.lastContact, r.readouts.today),
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
          value: readoutDayAgo(r.readouts.lastContact, r.readouts.today),
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
          value: readoutDayAgo(r.readouts.lastContact, r.readouts.today),
        },
        {
          label: 'Moving, 30 days',
          value: `${r.readouts.moving30}`,
          tone: r.readouts.moving30 === 0 ? 'muted' : undefined,
        },
      ]
  }
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
  target: PreviewTarget
  data: PreviewData | undefined
  actions: ReadonlyArray<PaneAction>
  onBack: () => void
}

/** The pane: 420px of bone right of the list, ruled off by a hairline. */
export const PreviewPane = forwardRef<HTMLElement, PaneProps>(
  function PreviewPane({ target, data, actions, onBack }, ref) {
    return (
      <aside
        ref={ref}
        data-preview={target.kind}
        aria-label="Preview"
        onKeyDown={(e) => onPaneKeyDown(e, onBack)}
        className="flex max-h-[420px] w-105 shrink-0 flex-col overflow-y-auto border-l border-hairline bg-bone"
      >
        {target.kind === 'record' ? (
          <RecordPane
            hit={target.hit}
            data={data?.kind === 'record' ? data.data : undefined}
            actions={actions}
          />
        ) : target.kind === 'object' ? (
          <ObjectPane
            label={target.label}
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
          size="xs"
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

function RecordPane({
  hit,
  data,
  actions,
}: {
  hit: PreviewHit
  data: RecordPreview | undefined
  actions: ReadonlyArray<PaneAction>
}) {
  const readouts = data?.readouts ? previewReadouts(data.readouts) : []
  return (
    <>
      <PreviewHead
        record
        stamp={data?.singular ?? KIND_LABELS[hit.kind] ?? hit.kind}
        crumb={(data?.spaces ?? []).map((s) => s.name).join(' · ')}
        mark={hit.picture ? <PictureMark src={hit.picture} size={22} /> : null}
        name={data?.name ?? hit.name}
      >
        {readouts.length > 0 ? (
          <ReadoutStrip readouts={readouts} size="pane" />
        ) : null}
      </PreviewHead>
      {data && data.fields.length > 0 ? (
        <dl className="flex flex-col px-5 pt-1">
          {data.fields.map((f) => (
            <div
              key={f.slug}
              data-field={f.slug}
              className="grid min-h-7.5 grid-cols-[7.5rem_1fr] items-center gap-3 border-b border-rule"
            >
              <dt className="truncate text-label text-graphite">{f.label}</dt>
              <dd className="min-w-0 truncate text-ui">{f.value}</dd>
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
  data,
  actions,
}: {
  label: string
  data: ObjectPreview | null | undefined
  actions: ReadonlyArray<PaneAction>
}) {
  const count = data ? data.views.length : null
  return (
    <>
      <PreviewHead
        stamp="Object"
        crumb={
          count === null ? '' : `${count} saved view${count === 1 ? '' : 's'}`
        }
        name={data?.plural ?? label}
      />
      {data && data.views.length > 0 ? (
        <ul className="flex flex-col pt-1">
          {data.views.map((v) => {
            const run = actions.find((a) => a.id === `view:${v.id}`)?.run
            return (
              <li key={v.id}>
                <button
                  type="button"
                  data-pane-action={`view:${v.id}`}
                  data-view={v.id}
                  onClick={run}
                  className="flex h-9 w-full items-center gap-3 border-b border-rule px-5 text-left text-ui outline-none hover:bg-paper focus-visible:bg-selected"
                >
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  <span
                    className={
                      v.count === null
                        ? 'shrink-0 mono text-micro text-graphite'
                        : 'shrink-0 mono text-micro'
                    }
                  >
                    {v.count === null ? DASH : v.count}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <Actions actions={actions.filter((a) => !a.id.startsWith('view:'))} />
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
  const pageOf =
    passage.page === null
      ? null
      : data?.pages
        ? `p.${String(passage.page)} of ${String(data.pages)}`
        : `p.${String(passage.page)}`
  const on = passage.kind === 'document' ? (passage.parent?.name ?? null) : null
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-5 pt-4">
        <Icon
          aria-hidden
          className="size-3.5 shrink-0 text-graphite"
          strokeWidth={1.75}
        />
        <span className="min-w-0 truncate mono text-micro">{passage.name}</span>
        {pageOf ? (
          <span data-page-of className="shrink-0 mono text-micro text-graphite">
            {pageOf}
          </span>
        ) : null}
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
      {on ? (
        <div className="px-5 pb-3 mono text-micro text-graphite">on {on}</div>
      ) : null}
      <Actions actions={actions} />
    </>
  )
}
