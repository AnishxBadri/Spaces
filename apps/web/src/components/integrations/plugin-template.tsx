import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { SettingsGroup } from '#/components/settings/settings-section'
import type { CapabilityOwner } from '#/lib/integrations/catalogue'
import type { IntegrationDetail } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { ROLLBACK_WORD, STATE_WORD } from './integration-ledger'

/**
 * One plugin's page, one template for every plugin. Six blocks in a fixed
 * order, each a `section[data-block]`:
 * - status and version, the workspace key, the data it sends out of the box,
 *   the manifest settings, what uses it elsewhere, and recent runs.
 * - A block with nothing to show and nothing to act on is not drawn; Status
 *   always is, so the page is never blank.
 * - The key and settings blocks are the caller's (they hold drafts); the
 *   rest are drawn from the detail alone.
 * - Used by only links: the owning page holds the settings.
 * - Disable and Uninstall are the caller's, in the head's `···`.
 */

export const PLUGIN_BLOCKS = [
  'status',
  'key',
  'sends',
  'settings',
  'used-by',
  'runs',
] as const
export type PluginBlockId = (typeof PLUGIN_BLOCKS)[number]

/**
 * The page that owns each capability. An owner not built yet links to the
 * catalogue and says so; its entry is the one line to change when it lands.
 * Enrichment links to its Fields grid.
 */
const OWNER = {
  enrichment: {
    label: 'Fields',
    to: '/settings/enrichment',
    hash: 'fields',
  },
  watching: { label: 'Watching · coming', to: '/spaces' },
  'email-calendar': {
    label: 'Email & calendar',
    to: '/settings/email-calendar',
  },
  files: { label: 'Files', to: '/settings/files' },
  'meeting-notes': { label: 'Meeting notes', to: '/settings/meeting-notes' },
  import: { label: 'Import', to: '/import' },
} as const satisfies {
  readonly [O in CapabilityOwner]: { label: string; to: string; hash?: string }
}

const LINK =
  'focus-ring rounded-md mono text-micro text-primary hover:text-foreground'

/**
 * A block: a group card, its head then its rows. Untitled, the block is a
 * column of the cards its children draw (the settings form's own groups).
 */
export function PluginBlock({
  id,
  title,
  count,
  children,
}: {
  id: PluginBlockId
  title?: string
  count?: string | undefined
  children: ReactNode
}) {
  if (title === undefined)
    return (
      <section data-block={id} className="flex flex-col gap-3">
        {children}
      </section>
    )
  return (
    <SettingsGroup data-block={id} title={title} count={count}>
      {children}
    </SettingsGroup>
  )
}

/** An empty block's one short line. */
function BlockEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="border-b border-rule px-(--inset) py-3 text-ui text-graphite">
      {children}
    </p>
  )
}

/** A label-left row, as the settings rows draw it. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-6 border-b border-rule px-(--inset) py-2">
      <span className="w-[13.125rem] shrink-0 text-ui font-medium text-foreground">
        {label}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-3">{children}</span>
    </div>
  )
}

function StatusBlock({ detail }: { detail: IntegrationDetail }) {
  const { rollback, held } = detail
  const tripped = detail.state === 'tripped'
  return (
    <PluginBlock id="status" title="Status" count={STATE_WORD[detail.state]}>
      <Row label="Version">
        <span className="mono text-micro text-foreground">
          v{detail.version}
        </span>
        {detail.update !== null ? (
          <span className="mono text-micro text-primary">
            → {detail.update} in the registry
          </span>
        ) : null}
      </Row>
      {rollback !== null ? (
        <Row label="Upgraded from">
          <span
            className={cn(
              'mono text-micro',
              rollback.answer === 'unsafe'
                ? 'text-[var(--badge-amber-ink)]'
                : 'text-graphite',
            )}
          >
            {rollback.from} · {ROLLBACK_WORD[rollback.answer]}
          </span>
        </Row>
      ) : null}
      {held !== null ? (
        <Row label="No update offered">
          <span className="mono text-micro text-graphite">{held}</span>
        </Row>
      ) : null}
      <Row label="Last run">
        <span className="mono text-micro text-graphite">
          {detail.lastRun ? `ran ${detail.lastRun.ago}` : 'never ran'}
        </span>
      </Row>
      <Row label="Usage today">
        <span className="numeric text-micro text-graphite">
          {detail.figure}
        </span>
      </Row>
      {detail.state === 'degraded' || tripped ? (
        <div
          role="status"
          className={cn(
            'flex flex-col gap-1 border-b border-rule px-(--inset) py-2',
            tripped ? 'bg-[var(--badge-rose)]' : 'bg-[var(--badge-amber)]',
          )}
        >
          <span
            className={cn(
              'text-ui',
              tripped ? 'text-destructive' : 'text-[var(--badge-amber-ink)]',
            )}
          >
            {tripped
              ? `${detail.reason ?? 'Stopped by the breaker'} · ${detail.errorCount} failed`
              : (detail.reason ?? 'The worker could not load it')}
          </span>
          {detail.fix !== null ? (
            <span className="text-label text-foreground">{detail.fix}</span>
          ) : null}
        </div>
      ) : null}
    </PluginBlock>
  )
}

function SendsBlock({ detail }: { detail: IntegrationDetail }) {
  if (detail.sends.length === 0) return null
  return (
    <PluginBlock id="sends" title="Data sent">
      <Row label="Sends">
        <span className="mono text-micro text-foreground">
          {detail.sends.join(' · ')}
        </span>
      </Row>
    </PluginBlock>
  )
}

function UsedByBlock({ detail }: { detail: IntegrationDetail }) {
  if (detail.capabilities.length === 0) return null
  return (
    <PluginBlock
      id="used-by"
      title="Used by"
      count={String(detail.capabilities.length)}
    >
      <ol>
        {detail.capabilities.map((c) => {
          const owner = OWNER[c.owner]
          return (
            <li
              key={`${c.owner}:${c.what}`}
              className="flex h-12 items-center gap-3 border-b border-rule px-(--inset)"
            >
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                {c.what}
              </span>
              <Link
                to={owner.to}
                {...('hash' in owner ? { hash: owner.hash } : {})}
                className={LINK}
              >
                {owner.label} ›
              </Link>
            </li>
          )
        })}
      </ol>
    </PluginBlock>
  )
}

const RUN_INK: Record<IntegrationDetail['runs'][number]['status'], string> = {
  running: 'text-foreground',
  succeeded: 'text-graphite',
  failed: 'text-destructive',
  skipped: 'text-graphite',
}

function RunsBlock({ detail }: { detail: IntegrationDetail }) {
  if (detail.runs.length === 0) return null
  return (
    <PluginBlock
      id="runs"
      title="Recent runs"
      count={String(detail.runs.length)}
    >
      <RunLines runs={detail.runs} />
    </PluginBlock>
  )
}

/** A plugin's runs, newest first: age, job, state, its one line, duration. */
export function RunLines({
  runs,
}: {
  runs: ReadonlyArray<IntegrationDetail['runs'][number]>
}) {
  if (runs.length === 0) return <BlockEmpty>No runs yet.</BlockEmpty>
  return (
    <ol>
      {runs.map((run) => (
        <li
          key={run.id}
          data-run={run.status}
          className="flex h-12 items-center gap-3 border-b border-rule px-(--inset)"
        >
          <span className="w-20 shrink-0 mono text-micro text-graphite">
            {run.ago}
          </span>
          <span className="w-32 shrink-0 truncate mono text-micro text-foreground">
            {run.job}
          </span>
          <span
            className={cn('w-20 shrink-0 mono text-micro', RUN_INK[run.status])}
          >
            {run.status}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-ui',
              run.status === 'failed' ? 'text-destructive' : 'text-graphite',
            )}
            {...(run.line === null ? {} : { title: run.line })}
          >
            {run.line ?? ''}
          </span>
          <span className="w-16 shrink-0 numeric text-right text-micro text-graphite">
            {run.duration ?? ''}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The blocks, in order; the key and settings blocks' rows are the caller's. */
export function PluginTemplate({
  detail,
  keyBlock,
  settingsBlock,
}: {
  detail: IntegrationDetail
  /** The key and webhook-secret rows; null when the plugin needs none. */
  keyBlock: ReactNode
  /** The manifest settings form; null when it declares none, or is unread. */
  settingsBlock: ReactNode
}) {
  const saved = detail.secrets.every((s) => s.display !== null)
  return (
    <>
      <StatusBlock detail={detail} />
      {keyBlock === null ? null : (
        <PluginBlock
          id="key"
          title="Workspace key"
          count={
            detail.secrets.length === 0
              ? undefined
              : saved
                ? 'saved'
                : 'not yet'
          }
        >
          {keyBlock}
        </PluginBlock>
      )}
      <SendsBlock detail={detail} />
      {settingsBlock === null ? null : (
        // The settings form draws its own head.
        <PluginBlock id="settings">{settingsBlock}</PluginBlock>
      )}
      <UsedByBlock detail={detail} />
      <RunsBlock detail={detail} />
    </>
  )
}
