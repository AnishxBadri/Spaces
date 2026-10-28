import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { Button } from '#/components/ui/button'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import type { SensitivityState } from '#/components/sensitive-toggle'
import { jobToast } from '#/lib/integrations/job-status-view'
import type { LastRun, RecordAction } from '#/lib/server-fns'
import {
  ENRICH_QUEUE,
  EnrichVerb,
  enrichToast,
  offeredActions,
  showJobToast,
  usePluginEntries,
  useRecordJobs,
} from './plugin-actions'
import type { RecordEnrichView } from './plugin-actions'
import { RecordMoreMenu } from './record-more-menu'
import type { TemplateKind } from './record-more-menu'

/**
 * The verbs at the right of a record head: `[verb] [verb] [···]` on every
 * kind (A4), outlined, keys in tooltips. Everything else a head once
 * carried — Sensitive, Save as template, the plugins' actions — is in the
 * `···`.
 */

export type HeadRecord = {
  id: string
  name: string
  kind: 'company' | 'person' | 'deal' | 'custom'
}

/**
 * A company's, person's, deal's or custom record's verbs: Log interaction
 * (`L`) where people are logged with it, then Enrich or the kind's own
 * verb, then the `···`.
 * - An archived record's head is the `···` alone, which carries Restore.
 * - One status stream feeds Enrich's label and the plugins' toasts.
 * - A finished Enrich toasts the line its reload brings back.
 */
export function RecordHeadActions({
  record,
  log = true,
  enrich,
  verbs,
  sensitivity,
  template,
  pluginActions = [],
  archived = false,
}: {
  record: HeadRecord
  /** Log interaction, bound to `L`. */
  log?: boolean | undefined
  /** The host's Enrich, on a company or a person. */
  enrich?: RecordEnrichView | undefined
  /** The kind's own verb after Log interaction: Move stage. */
  verbs?: ReactNode
  sensitivity?: SensitivityState | undefined
  template?: TemplateKind | undefined
  pluginActions?: ReadonlyArray<RecordAction> | undefined
  archived?: boolean | undefined
}) {
  const navigate = useNavigate()
  const offered = offeredActions(pluginActions, enrich !== undefined)
  const pluginOf = new Map<string, string>(
    offered.map((a) => [a.queue, a.pluginName]),
  )
  const review = () =>
    void navigate({ to: '/review', search: { record: record.id } })

  // The Enrich line before the run closed; undefined while none is awaited.
  const enrichBefore = useRef<LastRun | null | undefined>(undefined)
  const enrichNow = useRef(enrich)
  useEffect(() => {
    enrichNow.current = enrich
  })

  const jobs = useRecordJobs(
    record.id,
    offered.length > 0 || enrich !== undefined,
    (event) => {
      if (event.queue === ENRICH_QUEUE) {
        enrichBefore.current = enrichNow.current?.last ?? null
        return
      }
      const plugin = pluginOf.get(event.queue)
      const said = plugin === undefined ? null : jobToast(event, plugin)
      if (said !== null) showJobToast(said, review)
    },
  )

  const last = enrich?.last ?? null
  useEffect(() => {
    const before = enrichBefore.current
    if (before === undefined || last === null || last === before) return
    enrichBefore.current = undefined
    showJobToast(
      enrichToast(last),
      () => void navigate({ to: '/review', search: { record: record.id } }),
    )
  }, [last, navigate, record.id])

  const plugins = usePluginEntries(record.id, offered, jobs)

  const more = (
    <RecordMoreMenu
      name={record.name}
      entityId={record.id}
      template={template}
      sensitivity={sensitivity}
      archived={archived}
      plugins={plugins}
    />
  )
  if (archived) return more
  return (
    <>
      {log ? (
        <LogInteractionDialog
          seed={{ id: record.id, name: record.name, kind: record.kind }}
          hotkey="l"
          trigger={
            <Button variant="outline" shortcut="L">
              Log interaction
            </Button>
          }
        />
      ) : null}
      {enrich === undefined ? null : (
        <EnrichVerb entityId={record.id} enrich={enrich} jobs={jobs} />
      )}
      {verbs}
      {more}
    </>
  )
}

/** A deal's second verb, bound to `M`. */
export function MoveStageVerb({ onMove }: { onMove: () => void }) {
  return (
    <Button variant="outline" shortcut="M" onClick={onMove}>
      Move stage
    </Button>
  )
}

/** A term's head: a note that mentions it, then the `···`. */
export function TermHeadActions({
  name,
  onWriteNote,
}: {
  name: string
  onWriteNote: () => void
}) {
  return (
    <>
      <Button variant="outline" onClick={onWriteNote}>
        Write a note
      </Button>
      <RecordMoreMenu name={name} />
    </>
  )
}

/**
 * A holding's head: Record a mark, Record a check, then the `···`, which
 * carries the rarer entries (`more`). Each verb is its window's trigger, so
 * the page hands the windows in.
 */
export function HoldingHeadActions({
  name,
  recordMark,
  recordCheck,
  more = [],
}: {
  name: string
  recordMark: (trigger: ReactNode) => ReactNode
  recordCheck: (trigger: ReactNode) => ReactNode
  more?: ReadonlyArray<MoreMenuEntry> | undefined
}) {
  return (
    <>
      {recordMark(<Button variant="outline">Record a mark</Button>)}
      {recordCheck(<Button variant="outline">Record a check</Button>)}
      <RecordMoreMenu name={name} verbs={more} />
    </>
  )
}
