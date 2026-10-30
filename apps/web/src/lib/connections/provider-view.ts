import { formatDay } from '@spaces/core/format'
import type {
  ConnectionsListRow,
  ConsentType,
  GoogleAudience,
  ProviderUse,
} from './input'

/**
 * How Settings → Connections and a provider's page word what the server
 * read. Client-safe and pure, so the strings are tested without a page.
 */

/** A provider page's two tabs, in the bar's order. */
export const PROVIDER_TABS = ['setup', 'in-use'] as const
export type ProviderTab = (typeof PROVIDER_TABS)[number]

/** The tab a provider page opens on: In use once its client is active. */
export function defaultTab(configured: boolean): ProviderTab {
  return configured ? 'in-use' : 'setup'
}

/** The consent screen a Google audience points at: Internal for a Workspace domain. */
export function consentFor(audience: GoogleAudience): ConsentType {
  return audience === 'workspace' ? 'internal' : 'external'
}

/** `just now`, `3 min`, `5 h`, then the day. */
export function syncAge(iso: string, nowMs: number, today: string): string {
  const minutes = Math.floor(
    Math.max(0, nowMs - new Date(iso).getTime()) / 60_000,
  )
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} h`
  return formatDay(iso, today)
}

/** A use's mono lane: who uses it and when it last synced, or that it is off. */
export function whoLineOf(
  use: ProviderUse,
  nowMs: number,
  today: string,
): string {
  if (!use.enabled) return 'Off for this workspace'
  const people = `${String(use.people)} ${use.people === 1 ? 'person' : 'people'}`
  return use.lastSyncAt === null
    ? `${people} · never synced`
    : `${people} · last sync ${syncAge(use.lastSyncAt, nowMs, today)}`
}

/** A use's health over the week: `0 failed · 7 days`, or who it failed for. */
export function healthOf(use: ProviderUse): {
  readonly tone: 'ok' | 'bad'
  readonly text: string
} {
  if (use.failed === 0 && use.failedWho === null)
    return { tone: 'ok', text: '0 failed · 7 days' }
  return {
    tone: 'bad',
    text: `${String(use.failed)} failed · ${use.failedWho ?? '7 days'}`,
  }
}

export type ListStatus = {
  readonly tone: 'ink' | 'graphite' | 'bad'
  readonly text: string
  readonly link: { readonly label: string; readonly tab: ProviderTab }
}

/** A Connections row's status lane and its one link. */
export function listStatusOf(row: ConnectionsListRow): ListStatus {
  if (!row.configured)
    return {
      tone: 'ink',
      text: 'Not set up',
      link: { label: 'Set up ›', tab: 'setup' },
    }
  if (row.error !== null)
    return {
      tone: 'bad',
      text: row.error,
      link: { label: 'Fix ›', tab: 'setup' },
    }
  if (row.testing)
    return {
      tone: 'graphite',
      text: 'Testing · reconnects weekly',
      link: { label: 'Open ›', tab: 'in-use' },
    }
  return {
    tone: 'graphite',
    text: `Set up · ${String(row.membersConnected)} of ${String(row.members)} members connected`,
    link: { label: 'Open ›', tab: 'in-use' },
  }
}
