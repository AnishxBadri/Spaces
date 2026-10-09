import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import { SettingsSection } from './settings-section'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import type { ProviderId } from '@spaces/core/providers/registry'
import type { ProviderAppRow } from '#/lib/server-fns'
import { setProviderApp } from '#/lib/server-fns'

/**
 * Settings → Integrations → Connection apps: one OAuth client group per
 * provider — redirect URI, client id and a write-only secret, which never
 * reaches the page (a stored one reads as its `redact()` tail). Every
 * member's Connect leaves through these clients. (D81)
 */
export function ConnectionAppsSection({
  apps,
}: {
  apps: ReadonlyArray<ProviderAppRow>
}) {
  return (
    <SettingsSection
      title="Connection apps"
      blurb="The OAuth clients members connect their accounts through."
      crumb="Integrations"
    >
      {apps.map((app) => (
        <OAuthClientGroup key={app.provider} app={app} />
      ))}
    </SettingsSection>
  )
}

/** Where an accounts page's Configure › points an admin: the client group. */
export const oauthClientAnchor = (provider: ProviderId) =>
  `oauth-client-${provider}`

/**
 * One provider's client: the client id and a write-only secret as one draft
 * in the page's Save bar. The secret settles empty after a save; a stored one
 * reads as its redacted display.
 */
function OAuthClientGroup({ app }: { app: ProviderAppRow }) {
  const router = useRouter()
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
      toast(`${app.label} OAuth client saved`)
      void router.invalidate()
      return { clientId, secret: '' }
    },
  )

  return (
    <div id={oauthClientAnchor(app.provider)} className="flex flex-col pt-8">
      <SectionHead
        as="h3"
        title={`${app.label} OAuth client`}
        count={app.configured ? 'configured' : 'not configured'}
      />
      <RedirectUriRow uri={app.redirectUri} />
      <FieldRow label="Client ID">
        <Input
          aria-label={`${app.label} client ID`}
          autoComplete="off"
          spellCheck={false}
          value={draft.clientId}
          onChange={(e) => set('clientId', e.target.value)}
          className="mono"
        />
      </FieldRow>
      <FieldRow label="Secret">
        <Input
          aria-label={`${app.label} client secret`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft.secret}
          onChange={(e) => set('secret', e.target.value)}
          placeholder={
            app.secretDisplay === null
              ? 'client secret'
              : `${app.secretDisplay}${app.secretSetAt ? ` · set ${app.secretSetAt.slice(5, 10)}` : ''}`
          }
          className="mono"
        />
      </FieldRow>
    </div>
  )
}

/** Where the provider sends people back; pasted into its console as-is. */
function RedirectUriRow({ uri }: { uri: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <FieldRow label="Redirect URI">
      <Value select>{uri}</Value>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          void navigator.clipboard.writeText(uri).then(() => setCopied(true))
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </FieldRow>
  )
}

/** One row of the canvas's client ledger: caps label lane, mono value, control right. */
function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-3.5 border-b border-rule px-3 py-2">
      <span className="w-30 shrink-0 field-label text-graphite">{label}</span>
      {children}
    </div>
  )
}

function Value({
  children,
  select = false,
}: {
  children: ReactNode
  select?: boolean
}) {
  return (
    <span
      className={
        select
          ? 'min-w-0 flex-1 truncate mono text-label select-all'
          : 'min-w-0 flex-1 truncate mono text-label'
      }
    >
      {children}
    </span>
  )
}
