import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import {
  SettingsGroupHead,
  SettingsRow,
  SettingsSection,
} from './settings-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { useClock } from '#/components/clock'
import { formatDay } from '@spaces/core/format'
import type { ProviderId } from '@spaces/core/providers/registry'
import type { ProviderAppRow } from '#/lib/server-fns'
import { setProviderApp } from '#/lib/server-fns'

/**
 * Settings → Integrations → Connection apps: one OAuth client group per
 * provider — redirect address, client id and a write-only secret, which never
 * reaches the page (a stored one reads as `●●●● set MM-DD`). Every member's
 * Connect leaves through these clients.
 */
export function ConnectionAppsSection({
  apps,
}: {
  apps: ReadonlyArray<ProviderAppRow>
}) {
  return (
    <SettingsSection title="Connection apps" crumb="Integrations">
      {apps.map((app) => (
        <OAuthClientGroup key={app.provider} app={app} />
      ))}
    </SettingsSection>
  )
}

/** Where an accounts page's Configure › points an admin: the client group. */
export const oauthClientAnchor = (provider: ProviderId) =>
  `oauth-client-${provider}`

/** The group head's readout: who connects through the client, or that none is set. */
function connectedCount(app: ProviderAppRow): string {
  if (!app.configured) return 'not set up'
  const n = app.membersConnected
  return `${String(n)} ${n === 1 ? 'member' : 'members'} connected`
}

/**
 * One provider's client: the client id and a write-only secret as one draft
 * in the page's Save bar. A stored value reads as text with Edit or Replace;
 * the field opens only when asked. The secret settles empty after a save.
 */
function OAuthClientGroup({ app }: { app: ProviderAppRow }) {
  const router = useRouter()
  const { today } = useClock()
  const [editingId, setEditingId] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const { draft, set } = useSettingsDraft(
    { clientId: app.clientId ?? '', secret: '' },
    async (next) => {
      const clientId = next.clientId.trim()
      if (clientId === '') throw new Error(`Paste the ${app.label} client ID.`)
      if (!app.configured && next.secret.trim() === '')
        throw new Error(`Paste the ${app.label} client secret.`)
      await setProviderApp({
        data: { provider: app.provider, clientId, clientSecret: next.secret },
      })
      toast(`${app.label} client saved`)
      setEditingId(false)
      setReplacing(false)
      void router.invalidate()
      return { clientId, secret: '' }
    },
  )

  const showIdField = app.clientId === null || editingId
  const showSecretField = app.secretDisplay === null || replacing

  return (
    <div id={oauthClientAnchor(app.provider)} className="flex flex-col">
      <SettingsGroupHead title={app.label} count={connectedCount(app)} />
      <RedirectRow uri={app.redirectUri} />
      <SettingsRow label="Client ID">
        {showIdField ? (
          <Input
            aria-label={`${app.label} client ID`}
            autoComplete="off"
            spellCheck={false}
            value={draft.clientId}
            onChange={(e) => set('clientId', e.target.value)}
            placeholder="Paste the client ID"
            className="w-64 mono"
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate mono text-label">
              {app.clientId}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditingId(true)}
            >
              Edit
            </Button>
          </>
        )}
      </SettingsRow>
      <SettingsRow label="Client secret">
        {showSecretField ? (
          <Input
            aria-label={`${app.label} client secret`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft.secret}
            onChange={(e) => set('secret', e.target.value)}
            placeholder="Paste the client secret"
            className="w-64 mono"
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate mono text-label">
              <span aria-label="stored secret">●●●●</span>
              {app.secretSetAt
                ? ` set ${formatDay(app.secretSetAt, today)}`
                : ''}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReplacing(true)}
            >
              Replace
            </Button>
          </>
        )}
      </SettingsRow>
    </div>
  )
}

/** `https://deals.fund.example/api/…/callback` → `…/api/…/callback`. */
function pathOf(uri: string): string {
  const at = uri.indexOf('/', uri.indexOf('//') + 2)
  return at === -1 ? uri : `…${uri.slice(at)}`
}

/**
 * Where the provider sends people back; Copy takes the whole address, pasted
 * into its console as-is. The row prints its path, the origin is the title.
 */
function RedirectRow({ uri }: { uri: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <SettingsRow label="Redirect address">
      <span className="min-w-0 flex-1 truncate mono text-label" title={uri}>
        {pathOf(uri)}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          void navigator.clipboard.writeText(uri).then(() => setCopied(true))
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </SettingsRow>
  )
}
