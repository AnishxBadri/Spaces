import { Link, useRouter } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import { ReadoutStrip } from '#/components/record/record-parts'
import { Checkbox } from '#/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { Select, selectClasses } from '#/components/ui/select'
import { Switch } from '#/components/ui/switch'
import {
  saveEnrichmentAuto,
  saveEnrichmentOrder,
  saveEnrichmentReuse,
} from '#/lib/server-fns'
import type {
  AutoEnrichScopeName,
  EnrichmentAutoView,
  EnrichmentPage,
  EnrichmentSource,
  FillsWhat,
  GridAttribute,
  GridCell,
  RecentRun,
} from '#/lib/server-fns'
import { formatWhen } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'
import { useSettingsDraft } from './settings-form'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsSection,
  SettingsTip,
  useSettingsPage,
} from './settings-section'

/**
 * Settings → Integrations → Enrichment: where enriched values
 * come from. Top to bottom: three readouts (number above a sentence-case
 * label), the sources in order (drag or ↑↓; each row's switch takes a source
 * in or out of the order — the Website's is always on), when to enrich
 * automatically and how long an answer is reused, What fills what, and the
 * recent runs.
 * - Switches, ticks and the order apply at once with a toast; the reuse
 *   days are a typed field in the page's Save bar.
 * - A member reads it all, every control disabled (the row is admin-only).
 */
export function EnrichmentSection({ page }: { page: EnrichmentPage }) {
  return (
    <SettingsSection title="Enrichment" crumb="Integrations">
      <ReadoutStrip
        className="border-t-0 border-b border-rule"
        readouts={[
          {
            label: 'Fields filled · 7 days',
            value: String(page.readouts.fieldsWeek),
          },
          {
            label: 'Credits spent today',
            value: String(page.readouts.creditsToday),
          },
          {
            label: 'Waiting in Review',
            value: String(page.readouts.review),
            to: '/review',
          },
        ]}
      />
      <SourcesBlock key={orderKey(page.sources)} sources={page.sources} />
      <AutoBlock auto={page.auto} reuse={page.reuse} />
      <GridBlock grids={page.grids} />
      <RunsBlock runs={page.runs} />
    </SettingsSection>
  )
}

const orderKey = (sources: ReadonlyArray<EnrichmentSource>) =>
  sources.map((s) => `${s.id}:${s.on ? 1 : 0}`).join(',')

function moveItem<T>(
  list: ReadonlyArray<T>,
  from: number,
  to: number,
): Array<T> {
  if (to < 0 || to >= list.length || from === to) return [...list]
  const next = [...list]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row)
  return next
}

/** A source's mark: its initial, ink on paper reversed, 20px square. */
function SourceMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center bg-foreground mono text-micro text-paper"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

const LINK =
  'focus-ring rounded-md mono text-micro text-primary hover:text-foreground'

/**
 * Sources, in order: the first answer wins. The order is optimistic — the
 * move shows at once and snaps back if the write fails.
 */
function SourcesBlock({
  sources,
}: {
  sources: ReadonlyArray<EnrichmentSource>
}) {
  const router = useRouter()
  const { isAdmin } = useSettingsPage()
  const [rows, setRows] = useState(sources)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  useEffect(() => setRows(sources), [sources])

  async function persist(next: ReadonlyArray<EnrichmentSource>, done: string) {
    const prev = rows
    setRows(next)
    try {
      await saveEnrichmentOrder({
        data: { ids: next.filter((s) => s.on).map((s) => s.id) },
      })
      toast(done)
      void router.invalidate()
    } catch (err) {
      setRows(prev)
      toast.error(err instanceof Error ? err.message : 'Could not reorder')
    }
  }

  return (
    <section data-block="sources" className="flex flex-col">
      <SettingsGroupHead title="Sources, in order" action="first answer wins" />
      <ol aria-label="Enrichment sources">
        {rows.map((source, idx) => (
          <li
            key={source.id}
            data-source={source.builtIn ? 'website' : source.name}
            draggable={isAdmin}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/source-id', source.id)
              setDragging(source.id)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (over !== source.id) setOver(source.id)
            }}
            onDragEnd={() => {
              setDragging(null)
              setOver(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              const from = rows.findIndex((r) => r.id === dragging)
              setDragging(null)
              setOver(null)
              if (from >= 0 && from !== idx)
                void persist(moveItem(rows, from, idx), 'Order saved')
            }}
            className={cn(
              'flex min-h-13 items-center gap-3 border-b border-rule px-3 py-2 transition-[background-color,opacity] duration-150 ease-out-quart',
              dragging === source.id && 'opacity-50',
              over === source.id && dragging !== source.id && 'bg-bone',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'w-3 mono text-label',
                isAdmin
                  ? 'cursor-grab text-rule active:cursor-grabbing'
                  : 'text-transparent',
              )}
            >
              ⋮⋮
            </span>
            <span className="w-4 numeric text-micro text-graphite">
              {source.on ? idx + 1 : ''}
            </span>
            <SourceMark name={source.name} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-baseline gap-2 text-ui text-foreground">
                {source.name}
                {source.builtIn ? (
                  <span className="mono text-micro text-graphite">
                    built in
                  </span>
                ) : null}
              </span>
              <span className="truncate mono text-micro text-graphite">
                sends {source.sends}
              </span>
            </span>
            <span
              data-state
              className={cn(
                'w-44 shrink-0 truncate text-right mono text-micro',
                source.on && source.runnable
                  ? 'text-foreground'
                  : 'text-graphite',
              )}
            >
              {source.state}
            </span>
            <span className="flex w-28 shrink-0 items-center justify-end gap-2">
              <button
                type="button"
                aria-label={`Move ${source.name} up`}
                disabled={idx === 0}
                onClick={() =>
                  void persist(moveItem(rows, idx, idx - 1), 'Order saved')
                }
                className="focus-ring mono text-micro text-graphite hover:text-foreground disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${source.name} down`}
                disabled={idx === rows.length - 1}
                onClick={() =>
                  void persist(moveItem(rows, idx, idx + 1), 'Order saved')
                }
                className="focus-ring mono text-micro text-graphite hover:text-foreground disabled:opacity-30"
              >
                ↓
              </button>
              {source.builtIn ? (
                <span title="The Website is always asked">
                  <Switch
                    checked
                    disabled
                    aria-label={`Ask ${source.name}`}
                    onCheckedChange={() => undefined}
                  />
                </span>
              ) : (
                <Switch
                  checked={source.on}
                  aria-label={`Ask ${source.name}`}
                  onCheckedChange={(on) =>
                    void persist(
                      rows.map((r) => (r.id === source.id ? { ...r, on } : r)),
                      on ? `${source.name} on` : `${source.name} off`,
                    )
                  }
                />
              )}
            </span>
            <span className="w-20 shrink-0 text-right">
              {source.integrationId === null ? null : (
                <Link
                  to="/settings/plugins/$integrationId"
                  params={{ integrationId: source.integrationId }}
                  className={LINK}
                >
                  Configure ›
                </Link>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex h-9 items-center px-3">
        <Link to="/settings/plugins" className={LINK}>
          + Add a source from Plugins
        </Link>
      </div>
    </section>
  )
}

/**
 * The three auto-enrich scopes and the five trigger words they carry:
 * joining a deal and filing into a space each also cover a record created,
 * or gaining a domain or an email, while it is in one.
 */
const SCOPE_LABELS: ReadonlyArray<{
  readonly scope: AutoEnrichScopeName
  readonly label: string
  readonly hint: string | null
}> = [
  {
    scope: 'deal',
    label: 'joins a deal',
    hint: 'or is created, or gets a domain or email, while in one',
  },
  {
    scope: 'space',
    label: 'is filed in',
    hint: 'or is created, or gets a domain or email, while filed',
  },
  { scope: 'meeting', label: 'is in a meeting', hint: null },
]

type SpaceOption = EnrichmentAutoView['options'][number]

/** What the spaces picker reads: `any space`, the one space's path, or `n spaces`. */
export function spacesLabel(
  chosen: ReadonlyArray<string>,
  options: ReadonlyArray<SpaceOption>,
): string {
  const only = chosen.length === 1 ? chosen.at(0) : undefined
  if (chosen.length === 0) return 'any space'
  if (only !== undefined)
    return options.find((o) => o.id === only)?.label ?? '1 space'
  return `${chosen.length} spaces`
}

/**
 * The spaces `is filed in` covers, several at once; none chosen is any
 * space. Each tick saves, and the sheet stays open for the next.
 */
function SpacesPicker({
  chosen,
  options,
  disabled,
  onChange,
}: {
  chosen: ReadonlyArray<string>
  options: ReadonlyArray<SpaceOption>
  disabled: boolean
  onChange: (next: ReadonlyArray<string>) => void
}) {
  const keepOpen = (e: Event) => e.preventDefault()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Which spaces"
        disabled={disabled}
        className={
          selectClasses({
            width: 'content',
            className: 'h-6 rounded-none px-2 text-label',
          }).trigger
        }
      >
        <span className="min-w-0 flex-1 truncate">
          {spacesLabel(chosen, options)}
        </span>
        <ChevronDown
          aria-hidden
          className="size-3 shrink-0 text-graphite"
          strokeWidth={2}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 max-w-88">
        <DropdownMenuCheckboxItem
          checked={chosen.length === 0}
          onSelect={keepOpen}
          onCheckedChange={() => onChange([])}
        >
          any space
        </DropdownMenuCheckboxItem>
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.id}
            checked={chosen.includes(o.id)}
            onSelect={keepOpen}
            onCheckedChange={(on) =>
              onChange(
                on ? [...chosen, o.id] : chosen.filter((id) => id !== o.id),
              )
            }
          >
            <span className="truncate">{o.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AutoBlock({
  auto,
  reuse,
}: {
  auto: EnrichmentAutoView
  reuse: EnrichmentPage['reuse']
}) {
  const router = useRouter()
  const [scopes, setScopes] = useState(auto.scopes)
  const [spaces, setSpaces] = useState(auto.spaces)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    setScopes(auto.scopes)
    setSpaces(auto.spaces)
  }, [auto.scopes, auto.spaces])

  const reuseDraft = useSettingsDraft(
    { days: String(reuse.days) },
    async (next) => {
      const days = Number(next.days.trim())
      if (next.days.trim() === '' || !Number.isInteger(days) || days < 0)
        throw new Error('Re-use is a whole number of days.')
      await saveEnrichmentReuse({ data: { days } })
      toast('Re-use saved')
      void router.invalidate()
    },
  )

  async function save(
    nextScopes: ReadonlyArray<AutoEnrichScopeName>,
    nextSpaces: ReadonlyArray<string>,
  ) {
    const prev = { scopes, spaces }
    const ordered = SCOPE_LABELS.map((s) => s.scope).filter((s) =>
      nextScopes.includes(s),
    )
    setScopes(ordered)
    setSpaces(nextSpaces)
    setPending(true)
    try {
      await saveEnrichmentAuto({
        data: { scopes: ordered, spaces: [...nextSpaces] },
      })
      toast('Auto-enrich saved')
      void router.invalidate()
    } catch (err) {
      setScopes(prev.scopes)
      setSpaces(prev.spaces)
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  return (
    <section data-block="auto" className="flex flex-col">
      <SettingsGroupHead
        title="Enrich automatically when a record"
        count={
          auto.paid.length === 0
            ? 'no paid source'
            : scopes.length === 0
              ? 'off'
              : undefined
        }
      />
      <div className="grid grid-cols-2 border-b border-rule py-2 max-md:grid-cols-1">
        {SCOPE_LABELS.map((row) => {
          const id = `auto-${row.scope}`
          const checked = scopes.includes(row.scope)
          return (
            <div
              key={row.scope}
              className="flex min-h-10 items-start gap-2.5 py-1.5"
            >
              <Checkbox
                id={id}
                checked={checked}
                disabled={pending || auto.paid.length === 0}
                className="mt-[0.1875rem]"
                onCheckedChange={(on) =>
                  void save(
                    on
                      ? [...scopes, row.scope]
                      : scopes.filter((s) => s !== row.scope),
                    spaces,
                  )
                }
              />
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2">
                  <label htmlFor={id} className="text-ui text-foreground">
                    {row.label}
                  </label>
                  {row.scope === 'space' ? (
                    <SpacesPicker
                      chosen={spaces}
                      options={auto.options}
                      disabled={pending || auto.paid.length === 0}
                      onChange={(next) =>
                        void save(
                          next.length === 0 || scopes.includes('space')
                            ? scopes
                            : [...scopes, row.scope],
                          next,
                        )
                      }
                    />
                  ) : null}
                </span>
                {row.hint === null ? null : (
                  <span className="text-label text-graphite">{row.hint}</span>
                )}
              </span>
            </div>
          )
        })}
      </div>
      <SettingsRow label="Re-use a result for">
        <SettingsTip tip="A source answered within this many days is not asked again.">
          <Input
            id="enrichment-reuse"
            aria-label="Re-use days"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={reuseDraft.draft.days}
            onChange={(e) => reuseDraft.set('days', e.target.value)}
            className="w-24 mono"
          />
        </SettingsTip>
        <span className="mono text-micro text-graphite">days</span>
      </SettingsRow>
    </section>
  )
}

const CELL_LABEL: { readonly [C in GridCell]: string } = {
  fills: 'fills it',
  next: 'next in line',
  could: 'could, not used',
  none: 'cannot answer',
}

/** One grid cell: pine square fills, ink square next in line, an outline could. */
function Cell({ cell, source }: { cell: GridCell; source: string }) {
  return (
    <span
      data-cell={cell}
      title={`${source} · ${CELL_LABEL[cell]}`}
      className="flex w-20 shrink-0 justify-center"
    >
      {cell === 'none' ? (
        <span aria-hidden className="mono text-micro text-rule">
          ·
        </span>
      ) : (
        <span
          aria-label={`${source} ${CELL_LABEL[cell]}`}
          className={cn(
            'size-2',
            cell === 'fills' && 'bg-primary',
            cell === 'next' && 'bg-graphite',
            cell === 'could' && 'border border-graphite',
          )}
        />
      )}
    </span>
  )
}

/**
 * What fills what: per object, each attribute that can fill from the
 * vocabulary against the sources in order, and which one answers it. An
 * unlinked attribute reads "not linked" with Fill from…, which opens the
 * attribute's window.
 */
function GridBlock({ grids }: { grids: ReadonlyArray<FillsWhat> }) {
  const router = useRouter()
  const { isAdmin } = useSettingsPage()
  const [kind, setKind] = useState<FillsWhat['kind']>('company')
  const [editing, setEditing] = useState<GridAttribute | null>(null)
  const grid = grids.find((g) => g.kind === kind) ?? grids.at(0)
  if (grid === undefined) return null
  return (
    <section
      id="what-fills-what"
      data-block="grid"
      className="flex scroll-mt-6 flex-col"
    >
      <SettingsGroupHead
        title="What fills what"
        action={
          <Select<FillsWhat['kind']>
            aria-label="Object"
            value={grid.kind}
            onChange={setKind}
            items={grids.map((g) => ({ value: g.kind, label: g.label }))}
            width="content"
            className="h-6 w-auto rounded-none border-0 bg-transparent px-1 mono text-micro text-foreground"
          />
        }
      />
      <div
        aria-hidden
        className="flex h-8 items-center gap-3 border-b border-hairline px-3 text-label text-graphite"
      >
        <span className="min-w-0 flex-1">Attribute</span>
        <span className="w-44 shrink-0">Fill from</span>
        {grid.sources.map((s) => (
          <span key={s.id} className="w-20 shrink-0 truncate text-center">
            {s.name}
          </span>
        ))}
      </div>
      <ol aria-label={`${grid.label} attributes and their sources`}>
        {grid.rows.map((row) => (
          <li
            key={row.id}
            data-attribute={row.slug}
            className="flex h-9 items-center gap-3 border-b border-rule px-3"
          >
            <span
              className={cn(
                'flex min-w-0 flex-1 items-baseline gap-2 truncate text-ui',
                row.key === null ? 'text-graphite' : 'text-foreground',
              )}
            >
              {row.name}
              {row.isSystem ? null : (
                <span className="mono text-micro text-graphite">yours</span>
              )}
            </span>
            <span className="flex w-44 shrink-0 items-baseline gap-2 truncate">
              {row.key === null ? (
                <>
                  <span className="mono text-micro text-graphite">
                    not linked
                  </span>
                  {isAdmin ? (
                    <button
                      type="button"
                      onClick={() => setEditing(row)}
                      className={LINK}
                    >
                      Fill from…
                    </button>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  disabled={!isAdmin}
                  title={row.key}
                  onClick={() => setEditing(row)}
                  className="focus-ring truncate mono text-micro text-foreground hover:text-primary disabled:hover:text-foreground"
                >
                  {row.keyWord}
                </button>
              )}
            </span>
            {grid.sources.map((s, i) => (
              <Cell key={s.id} cell={row.cells[i] ?? 'none'} source={s.name} />
            ))}
          </li>
        ))}
        {grid.rows.length === 0 ? (
          <li className="border-b border-rule px-3 py-3 text-ui text-graphite">
            No attribute here can fill from enrichment.
          </li>
        ) : null}
      </ol>
      <div
        aria-hidden
        className="flex h-8 items-center gap-4 px-3 mono text-micro text-graphite"
      >
        <span className="flex items-center gap-1.5">
          <span className="size-2 bg-primary" /> fills it
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 bg-graphite" /> next in line
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 border border-graphite" /> could, not used
        </span>
      </div>
      {editing === null ? null : (
        <AttributeDialog
          mode="edit"
          attr={editing}
          objectLabel={kind}
          objectPlural={grid.label}
          fillFrom={kind}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSaved={() => void router.invalidate()}
        />
      )}
    </section>
  )
}

function RunsBlock({ runs }: { runs: ReadonlyArray<RecentRun> }) {
  const { now } = useClock()
  return (
    <section data-block="runs" className="flex flex-col">
      <SettingsGroupHead
        title="Recent runs"
        count={runs.length === 0 ? undefined : String(runs.length)}
      />
      {runs.length === 0 ? (
        <p className="border-b border-rule px-3 py-3 text-ui text-graphite">
          No runs yet.
        </p>
      ) : (
        <ol>
          {runs.map((run) => (
            <li
              key={run.id}
              className="flex h-ledger-row items-center gap-3 border-b border-rule px-3"
            >
              <span className="w-24 shrink-0 numeric text-micro text-graphite">
                {formatWhen(run.at, now)}
              </span>
              <span className="w-36 shrink-0 truncate text-ui">
                <RecordLink run={run} />
              </span>
              <span className="w-36 shrink-0 truncate mono text-micro text-graphite">
                {run.why}
              </span>
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                {run.line.replace(/^Enriched · /, '')}
              </span>
              <span className="w-16 shrink-0 numeric text-right text-micro text-graphite">
                {run.credits === 0
                  ? '—'
                  : `${run.credits} credit${run.credits === 1 ? '' : 's'}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function RecordLink({ run }: { run: RecentRun }) {
  const cls = 'focus-ring hover:underline'
  if (run.recordKind === 'company')
    return (
      <Link
        to="/companies/$companyId"
        params={{ companyId: run.recordId }}
        className={cls}
      >
        {run.recordName}
      </Link>
    )
  if (run.recordKind === 'person')
    return (
      <Link
        to="/people/$personId"
        params={{ personId: run.recordId }}
        className={cls}
      >
        {run.recordName}
      </Link>
    )
  return <>{run.recordName}</>
}
