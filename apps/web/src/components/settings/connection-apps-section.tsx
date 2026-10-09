import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
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

/** Where Connections' not-configured band points an admin: the client group. */
export const oauthClientAnchor = (provider: ProviderId) =>
  `oauth-client-${provider}`

function OAuthClientGroup({ app }: { app: ProviderAppRow }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [clientId, setClientId] = useState(app.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = editing || !app.configured

  function edit() {
    setClientId(app.clientId ?? '')
    setSecret('')
    setError(null)
    setEditing(true)
  }

  async function save() {
    const missing =
      clientId.trim() === ''
        ? 'Paste the client ID.'
        : !app.configured && secret.trim() === ''
          ? 'Paste the client secret.'
          : null
    if (missing !== null) {
      setError(missing)
      return
    }
    setPending(true)
    setError(null)
    try {
      await setProviderApp({
        data: { provider: app.provider, clientId, clientSecret: secret },
      })
      setSecret('')
      setEditing(false)
      toast(`${app.label} OAuth client saved`)
      await router.invalidate()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not save the OAuth client',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div id={oauthClientAnchor(app.provider)} className="flex flex-col pt-8">
      <SectionHead
        as="h3"
        title={`${app.label} OAuth client`}
        count={app.configured ? 'configured' : 'not configured'}
      />
      <RedirectUriRow uri={app.redirectUri} />
      <FieldRow label="Client ID">
        {open ? (
          <Input
            aria-label={`${app.label} client ID`}
            autoComplete="off"
            spellCheck={false}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="mono"
          />
        ) : (
          <>
            <Value>{app.clientId}</Value>
            <Button size="sm" variant="outline" onClick={edit}>
              Edit
            </Button>
          </>
        )}
      </FieldRow>
      <FieldRow label="Secret">
        {open ? (
          <Input
            aria-label={`${app.label} client secret`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={app.secretDisplay ?? 'client secret'}
            className="mono"
          />
        ) : (
          <>
            <Value>
              {app.secretDisplay}
              {app.secretSetAt ? ` · set ${app.secretSetAt.slice(5, 10)}` : ''}
            </Value>
            <Button size="sm" variant="outline" onClick={edit}>
              Replace
            </Button>
          </>
        )}
      </FieldRow>
      {open ? (
        <div className="flex min-h-12 items-center justify-end gap-3 border-b border-rule px-3 py-2">
          {error ? (
            <span
              role="alert"
              className="mr-auto mono text-micro text-destructive"
            >
              {error}
            </span>
          ) : null}
          {app.configured ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          ) : null}
          <Button size="sm" onClick={() => void save()} disabled={pending}>
            {pending ? 'Saving' : 'Save'}
          </Button>
        </div>
      ) : null}
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
