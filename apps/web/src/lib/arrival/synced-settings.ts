import { z } from 'zod'
import type { IntegrationConfig } from '@spaces/db/schema'
import { DEFAULT_MAIL_EXCLUDE } from './noise'
import type { MailExclude } from './noise'

/**
 * A connected mailbox's settings, read from its integration row's config —
 * the keys the Gmail plugin's manifest declares, with the same defaults.
 * - `shareBodies` defaults off: synced bodies private to the
 *   mailbox owner. Subject, participants and date are always visible.
 * - A key that is absent or unreadable reads as its default, never as
 *   "share": a config this cannot parse must not widen who reads mail.
 */
export type SyncedMailSettings = {
  shareBodies: boolean
  exclude: MailExclude
}

const strings = z.array(z.string())

export function syncedMailSettingsOf(
  config: IntegrationConfig,
): SyncedMailSettings {
  const share = z.boolean().safeParse(config.shareBodies)
  const senders = strings.safeParse(config.excludeSenders)
  const labels = strings.safeParse(config.excludeLabels)
  return {
    shareBodies: share.success ? share.data : false,
    exclude: {
      senders: senders.success ? senders.data : DEFAULT_MAIL_EXCLUDE.senders,
      labels: labels.success ? labels.data : DEFAULT_MAIL_EXCLUDE.labels,
    },
  }
}

/** The config keys, as the plugin's manifest names them. */
export function syncedMailConfig(
  settings: SyncedMailSettings,
): IntegrationConfig {
  return {
    shareBodies: settings.shareBodies,
    excludeSenders: [...settings.exclude.senders],
    excludeLabels: [...settings.exclude.labels],
  }
}
