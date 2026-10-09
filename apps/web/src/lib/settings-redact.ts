import type { AiProviderRow } from './ai/providers/settings'
import type { EmbeddingSettingsView } from './ai/providers/embed/settings'
import type { MailboxSettingsView } from './arrival/settings'
import type { ProviderAppRow } from './connections/input'
import type { IntegrationDetail } from './integrations/ledger'

/**
 * What a member reads of an admin settings page: the same shapes, with every
 * secret redacted to one word. (D81)
 * - A stored key's display (`sk-…7Hq2`) reads `set`; none stored stays null.
 * - Header values and a plugin's webhook URL are secrets too.
 * - The admin's reads are unchanged; writes refuse a member regardless.
 */
export const REDACTED = 'set'

export const redactDisplay = (display: string | null): string | null =>
  display === null ? null : REDACTED

export const redactProviderRow = (row: AiProviderRow): AiProviderRow => ({
  ...row,
  display: redactDisplay(row.display),
  headers: Object.fromEntries(
    Object.keys(row.headers).map((name) => [name, REDACTED]),
  ),
})

export const redactEmbeddingSettings = (
  view: EmbeddingSettingsView,
): EmbeddingSettingsView => ({
  ...view,
  keys: view.keys.map((k) => ({ ...k, display: redactDisplay(k.display) })),
})

export const redactMailboxSettings = (
  view: MailboxSettingsView,
): MailboxSettingsView => ({
  ...view,
  mailbox:
    view.mailbox === null
      ? null
      : {
          ...view.mailbox,
          passwordDisplay: redactDisplay(view.mailbox.passwordDisplay),
        },
})

export const redactProviderApp = (app: ProviderAppRow): ProviderAppRow => ({
  ...app,
  secretDisplay: redactDisplay(app.secretDisplay),
})

export const redactIntegrationDetail = (
  detail: IntegrationDetail,
): IntegrationDetail => ({
  ...detail,
  secrets: detail.secrets.map((s) => ({
    ...s,
    display: redactDisplay(s.display),
  })),
  webhookUrl: null,
})
