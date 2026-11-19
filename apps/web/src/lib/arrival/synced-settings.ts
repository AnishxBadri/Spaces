import { Option, Schema } from 'effect'
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

const readShare = Schema.decodeUnknownOption(Schema.Boolean)
const readStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String))

export function syncedMailSettingsOf(
  config: IntegrationConfig,
): SyncedMailSettings {
  return {
    shareBodies: Option.getOrElse(readShare(config.shareBodies), () => false),
    exclude: {
      senders: Option.getOrElse(
        readStrings(config.excludeSenders),
        () => DEFAULT_MAIL_EXCLUDE.senders,
      ),
      labels: Option.getOrElse(
        readStrings(config.excludeLabels),
        () => DEFAULT_MAIL_EXCLUDE.labels,
      ),
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
