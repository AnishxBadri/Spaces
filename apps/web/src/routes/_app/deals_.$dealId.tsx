import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { RailField } from '#/components/attributes/rail-field'
import { OptionChip } from '#/components/attributes/value-editor'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { TasksRail } from '#/components/tasks-rail'
import { MoveStageDialog } from '#/components/deal-board'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { KeyHint } from '#/components/page-header'
import {
  DitherMark,
  InitialsMark,
  PropertyCell,
  RailEmpty,
  RailItem,
  RailSection,
  RecordBody,
  RecordHeader,
  RecordSection,
  PropertyGrid,
  StageStepper,
} from '#/components/record/record-parts'
import { RecordFiles } from '#/components/record-files'
import { RecordTimeline } from '#/components/record-timeline'
import { TaskComposer } from '#/components/task-composer'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { fmtMoney } from '@spaces/core/portfolio/format'
import { localToday } from '@spaces/core/tasks/parse-due'
import { useHotkey } from '#/lib/use-hotkey'
import { jsonString } from '#/lib/json'
import {
  createNote,
  getDeal,
  getRecordTimeline,
  listRecordDocuments,
  listRegistry,
  updateRecord,
} from '#/lib/server-fns'

export const Route = createFileRoute('/_app/deals_/$dealId')({
  loader: async ({ params }) => {
    const [deal, registry, timeline, documents] = await Promise.all([
      getDeal({ data: { id: params.dealId } }),
      listRegistry({ data: { kind: 'deal' } }),
      getRecordTimeline({ data: { entityId: params.dealId } }),
      listRecordDocuments({ data: { entityId: params.dealId } }),
    ])
    if (deal.mergedIntoId) {
      throw redirect({
        to: '/deals/$dealId',
        params: { dealId: deal.mergedIntoId },
      })
    }
    return { deal, registry, timeline, documents }
  },
  component: DealRecordPage,
})

function DealRecordPage() {
  const { deal, registry, timeline, documents } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [moveOpen, setMoveOpen] = useState(false)
  useHotkey(
    'm',
    useCallback(() => setMoveOpen(true), []),
  )

  const refNames = {
    ...deal.refNames,
    ...Object.fromEntries(
      Object.entries(deal.userNames).map(([id, name]) => [id, { name }]),
    ),
  }
  const companyId = jsonString(deal.values.company)
  // refNames' Record index type hides misses — annotate the lookup honestly.
  const companyRef: { name: string } | undefined = companyId
    ? deal.refNames[companyId]
    : undefined
  const noteMentions = deal.mentionedIn.filter((m) => m.kind === 'note')

  const stageDef = registry.find((d) => d.slug === 'stage')
  const stageOptions = stageDef?.options.options ?? []
  const stageOption = stageOptions.find((o) => o.id === deal.values.stage)
  // Move-stage never offers a retired stage; the header chip still shows one.
  const liveStages = stageOptions.filter((o) => !o.archived)

  // The readouts: our check, the company, the owner, the close, and days in
  // the current stage — the last from the stage log, never stored.
  const today = localToday()
  const valueCode =
    registry.find((d) => d.slug === 'value')?.options.code ?? 'USD'
  const rawValue = deal.values.value
  const ourCheck =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string' && rawValue !== ''
        ? Number(rawValue)
        : null
  const ownerId = jsonString(deal.values.owner)
  const ownerName = ownerId ? deal.userNames[ownerId] : undefined
  const closeDate =
    typeof deal.values.close_date === 'string' ? deal.values.close_date : null
  const daysUntil = (iso: string) =>
    Math.round(
      (new Date(`${iso}T00:00:00Z`).getTime() -
        new Date(`${today}T00:00:00Z`).getTime()) /
        86_400_000,
    )
  const stageEntered =
    timeline.find(
      (i) => i.type === 'attrs' && i.changes.some((c) => c.slug === 'stage'),
    )?.at ?? deal.createdAt
  const daysInStage = Math.max(
    0,
    Math.floor((Date.now() - new Date(stageEntered).getTime()) / 86_400_000),
  )
  const peopleIds = Array.isArray(deal.values.people)
    ? deal.values.people.map(String)
    : []
  // refNames' Record index type hides misses; hasOwn is the honest test.
  const people = peopleIds.flatMap((id) =>
    Object.hasOwn(deal.refNames, id)
      ? [{ id, name: deal.refNames[id].name }]
      : [],
  )

  async function save(patch: Record<string, unknown>) {
    try {
      await updateRecord({ data: { id: deal.id, patch } })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      void router.invalidate()
    }
  }

  async function newNoteAboutThis() {
    try {
      const { id } = await createNote({
        data: { about: { entityId: deal.id, label: deal.name, kind: 'deal' } },
      })
      void navigate({ to: '/notes/$noteId', params: { noteId: id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      {moveOpen && liveStages.length > 0 ? (
        // Same post-mortem gate the board's drag path has — Passed/Lost ask
        // for a reason inside the dialog.
        <MoveStageDialog
          dealName={deal.name}
          stages={liveStages}
          currentId={stageOption?.id ?? null}
          daysInStage={daysInStage}
          onCancel={() => setMoveOpen(false)}
          onMove={(stageId, reason) => {
            void save({
              stage: stageId,
              ...(reason ? { close_reason: reason } : {}),
            })
            setMoveOpen(false)
          }}
        />
      ) : null}

      <RecordHeader
        crumb={
          <>
            <Link to="/deals" className="focus-ring hover:text-foreground">
              Deals
            </Link>
            {' / '}
            {deal.id.slice(0, 8)}
            {' / opened '}
            {deal.createdAt.slice(0, 10)}
          </>
        }
        actions={
          <>
            <LogInteractionDialog
              seed={{ id: deal.id, name: deal.name, kind: 'deal' }}
              hotkey="l"
              trigger={
                <Button variant="outline">
                  Log interaction
                  <KeyHint>L</KeyHint>
                </Button>
              }
            />
            <TaskComposer
              presetEntity={{ id: deal.id, name: deal.name, kind: 'deal' }}
              hotkey="t"
              trigger={
                <Button variant="outline">
                  Task
                  <KeyHint>T</KeyHint>
                </Button>
              }
            />
            {liveStages.length > 0 ? (
              <Button onClick={() => setMoveOpen(true)}>
                Move stage
                <KeyHint>M</KeyHint>
              </Button>
            ) : null}
          </>
        }
        mark={<DitherMark />}
        name={deal.name}
        badges={
          <>
            {stageOption && stageDef ? (
              <OptionChip
                def={stageDef}
                id={stageOption.id}
                className="h-5 shrink-0 py-0 leading-5"
              />
            ) : null}
            {deal.outsideMandate ? (
              // A hint, never a block — edge cases are the job. Deliberately
              // quiet: same-hue tint, no red.
              // Amber is named, not resolved: `optionColor` returns a stored
              // colour unchanged, so the one badge the instrument colours for
              // itself goes through the same primitive as the data-coloured
              // ones.
              <Badge
                asChild
                option={{ color: 'amber' }}
                index={0}
                className="shrink-0 gap-1"
              >
                <Link
                  to="/mandate"
                  title="This company's stage is outside the mandate's stages. Click to review the mandate."
                >
                  <Compass className="size-3" strokeWidth={2} />
                  Outside mandate
                </Link>
              </Badge>
            ) : null}
          </>
        }
        readouts={[
          {
            label: 'Our check',
            value:
              ourCheck !== null && Number.isFinite(ourCheck)
                ? fmtMoney(ourCheck, valueCode)
                : '—',
            tone: ourCheck === null ? 'muted' : undefined,
          },
          {
            label: 'Company',
            value: companyId ? (
              <Link
                to="/companies/$companyId"
                params={{ companyId }}
                className="focus-ring hover:underline"
              >
                {companyRef?.name ?? 'Company'}
              </Link>
            ) : (
              '—'
            ),
            kind: 'text',
            tone: companyId ? undefined : 'muted',
          },
          {
            label: 'Owner',
            value: ownerName ?? '—',
            kind: 'text',
            tone: ownerName ? undefined : 'muted',
          },
          {
            label: 'Close',
            value: closeDate
              ? `${closeDate} ${daysUntil(closeDate) < 0 ? '−' : ''}${Math.abs(daysUntil(closeDate))}d`
              : '—',
            tone: closeDate
              ? daysUntil(closeDate) < 0
                ? 'bad'
                : undefined
              : 'muted',
          },
          { label: 'Days in stage', value: `${daysInStage}` },
        ]}
      />

      <RecordBody
        rail={
          <>
            <RailSection
              label="Pipeline"
              meta={
                stageOption
                  ? `${Math.max(1, liveStages.findIndex((o) => o.id === stageOption.id) + 1)} of ${liveStages.length}`
                  : undefined
              }
            >
              <StageStepper
                stages={liveStages}
                currentId={stageOption?.id ?? null}
                days={daysInStage}
              />
            </RailSection>
            <TasksRail
              entityId={deal.id}
              entityName={deal.name}
              entityKind="deal"
            />
            <RailSection label="People" meta={`${people.length}`}>
              {people.length === 0 ? (
                <RailEmpty>No one linked yet — set People above.</RailEmpty>
              ) : (
                people.map((p) => (
                  <RailItem key={p.id}>
                    <InitialsMark name={p.name} />
                    <Link
                      to="/people/$personId"
                      params={{ personId: p.id }}
                      className="focus-ring min-w-0 truncate hover:underline"
                    >
                      {p.name}
                    </Link>
                  </RailItem>
                ))
              )}
            </RailSection>
          </>
        }
      >
        <PropertyGrid>
          {registry.map((def) => (
            <RailField
              key={def.slug}
              def={def}
              attr={def}
              objectLabel={'deal'}
              onAttributeSaved={() => router.invalidate()}
              value={deal.values[def.slug] ?? null}
              refNames={refNames}
              onSave={async (v) => {
                await updateRecord({
                  data: { id: deal.id, patch: { [def.slug]: v } },
                })
                void router.invalidate()
              }}
            />
          ))}
          <PropertyCell label="">
            <AttributeCreateDialog
              objectKind="deal"
              onCreated={() => router.invalidate()}
              trigger={
                <button className="focus-ring mono text-micro text-graphite hover:text-foreground">
                  + add attribute
                </button>
              }
            />
          </PropertyCell>
        </PropertyGrid>

        <RecordSection
          label="Notes"
          meta={`${noteMentions.length} note${noteMentions.length === 1 ? '' : 's'}`}
          action={
            <button
              type="button"
              onClick={newNoteAboutThis}
              className="focus-ring text-primary hover:underline"
            >
              note about this ›
            </button>
          }
        >
          {noteMentions.length === 0 ? (
            <p className="border-t border-rule py-2 text-label text-graphite">
              No notes mention this deal yet — diligence notes land here.
            </p>
          ) : (
            <ol>
              {noteMentions.map((m) => (
                <li key={m.fromId} className="border-t border-rule">
                  <Link
                    to="/notes/$noteId"
                    params={{ noteId: m.fromId }}
                    className="focus-ring-inset flex h-row items-center gap-3 text-ui hover:bg-bone"
                  >
                    <span className="font-serif text-title font-medium">
                      {m.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </RecordSection>

        <RecordSection
          rule
          label="Ledger"
          meta={`${timeline.length} entr${timeline.length === 1 ? 'y' : 'ies'}`}
        >
          <LogInteractionDialog
            seed={{ id: deal.id, name: deal.name, kind: 'deal' }}
            trigger={
              <button className="focus-ring-inset flex h-row w-full items-center gap-3 border-t border-b border-rule text-left">
                <span className="mono text-micro text-primary">+</span>
                <span className="min-w-0 truncate text-ui text-graphite">
                  Log a call, meeting, or note…
                </span>
                <span className="flex-1" />
                <KeyHint>L</KeyHint>
              </button>
            }
          />
          <RecordTimeline
            items={timeline}
            registry={registry}
            refNames={refNames}
          />
        </RecordSection>

        <RecordSection
          rule
          label="Files"
          meta={`${documents.length} file${documents.length === 1 ? '' : 's'}`}
        >
          <RecordFiles entityId={deal.id} documents={documents} />
        </RecordSection>
      </RecordBody>
    </div>
  )
}
