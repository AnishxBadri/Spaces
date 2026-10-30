import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { SettingsGroupHead } from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import type { CapabilityOwner } from '#/lib/integrations/catalogue'
import type { IntegrationDetail } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { ROLLBACK_WORD, STATE_WORD } from './integration-ledger'

/**
 * One plugin's page, one template for every plugin. Seven blocks in a
 * fixed order, each a `section[data-block]`:
 * - status and version, the workspace key, what it sends out of the box,
 *   the manifest settings, what it switches on, recent runs, and Disable /
 *   Uninstall.
 * - The key and settings blocks are the caller's (they hold drafts); the
 *   rest are drawn from the detail alone.
 * - What it switches on only links: the owning page holds the settings.
 */

export const PLUGIN_BLOCKS = [
  'status',
  'key',
  'sends',
  'settings',
  'switches-on',
  'runs',
  'remove',
] as const
export type PluginBlockId = (typeof PLUGIN_BLOCKS)[number]

/**
 * The page that owns each capability. An owner not built yet links to the
 * catalogue and says so; its entry is the one line to change when it lands.
 * Enrichment links to its What fills what grid.
 */
const OWNER = {
  enrichment: {
    label: 'What fills what',
    to: '/settings/enrichment',
    hash: 'what-fills-what',
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

/** A block: the section head band, then its rows. */
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
  return (
    <section data-block={id} className="flex flex-col">
      {title === undefined ? null : (
        <div className="flex flex-col">
          <SettingsGroupHead title={title} count={count} />
        </div>
      )}
      {children}
    </section>
  )
}

/** An empty block's one short line. */
export function BlockEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="border-b border-rule px-3 py-3 text-ui text-graphite">
      {children}
    </p>
  )
}

/** A label-left row, as the settings rows draw it. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-ledger-row items-center gap-3 border-b border-rule px-3 py-2">
      <span className="w-40 shrink-0 text-ui text-foreground">{label}</span>
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
      <Row label="Usage">
        <span className="numeric text-micro text-graphite">
          {detail.figure}
        </span>
      </Row>
      {detail.state === 'degraded' || tripped ? (
        <div
          role="status"
          className={cn(
            'flex flex-col gap-1 border-b border-rule px-3 py-2',
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
  return (
    <PluginBlock id="sends" title="What it sends">
      {detail.sends.length === 0 ? (
        <BlockEmpty>Not read yet.</BlockEmpty>
      ) : (
        <Row label="Sends">
          <span className="mono text-micro text-foreground">
            {detail.sends.join(' · ')}
          </span>
        </Row>
      )}
    </PluginBlock>
  )
}

function SwitchesOnBlock({ detail }: { detail: IntegrationDetail }) {
  return (
    <PluginBlock
      id="switches-on"
      title="What it switches on"
      count={
        detail.capabilities.length === 0
          ? undefined
          : String(detail.capabilities.length)
      }
    >
      {detail.capabilities.length === 0 ? (
        <BlockEmpty>Nothing elsewhere.</BlockEmpty>
      ) : (
        <ol>
          {detail.capabilities.map((c) => {
            const owner = OWNER[c.owner]
            return (
              <li
                key={`${c.owner}:${c.what}`}
                className="flex h-ledger-row items-center gap-3 border-b border-rule px-3"
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
      )}
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
  return (
    <PluginBlock
      id="runs"
      title="Recent runs"
      count={detail.runs.length === 0 ? undefined : String(detail.runs.length)}
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
          className="flex h-ledger-row items-center gap-3 border-b border-rule px-3"
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

function RemoveBlock({
  detail,
  pending,
  onToggle,
  onUninstall,
}: {
  detail: IntegrationDetail
  pending: boolean
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
}) {
  return (
    <PluginBlock id="remove" title="Disable or uninstall">
      <div className="flex min-h-ledger-row items-center gap-3 border-b border-rule px-3 py-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onToggle(!detail.enabled)}
        >
          {detail.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onUninstall}
        >
          Uninstall…
        </Button>
      </div>
    </PluginBlock>
  )
}

/** The seven blocks, in order; the key and settings blocks' rows are the caller's. */
export function PluginTemplate({
  detail,
  keyBlock,
  settingsBlock,
  pending,
  onToggle,
  onUninstall,
}: {
  detail: IntegrationDetail
  /** The key and webhook-secret rows; null when the plugin needs none. */
  keyBlock: ReactNode
  /** The manifest settings form; null when it declares none. */
  settingsBlock: ReactNode
  pending: boolean
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
}) {
  const saved = detail.secrets.every((s) => s.display !== null)
  return (
    <>
      <StatusBlock detail={detail} />
      <PluginBlock
        id="key"
        title="Workspace key"
        count={
          detail.secrets.length === 0 ? undefined : saved ? 'saved' : 'not yet'
        }
      >
        {keyBlock ?? <BlockEmpty>No workspace key.</BlockEmpty>}
      </PluginBlock>
      <SendsBlock detail={detail} />
      {settingsBlock === null ? (
        <PluginBlock id="settings" title="Settings">
          <BlockEmpty>No settings.</BlockEmpty>
        </PluginBlock>
      ) : (
        // The settings form draws its own head.
        <PluginBlock id="settings">{settingsBlock}</PluginBlock>
      )}
      <SwitchesOnBlock detail={detail} />
      <RunsBlock detail={detail} />
      <RemoveBlock
        detail={detail}
        pending={pending}
        onToggle={onToggle}
        onUninstall={onUninstall}
      />
    </>
  )
}
