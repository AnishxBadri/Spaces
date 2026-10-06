import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { SettingsSection } from './settings-section'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { PROVIDERS } from '@spaces/core/providers/registry'
import type { ProviderId } from '@spaces/core/providers/registry'
import {
  CONNECT_PRODUCT,
  connectHref,
  productOf,
  productScopes,
} from '#/lib/connections/products'
import type { ProviderAppRow } from '#/lib/server-fns'
import { setProviderApp } from '#/lib/server-fns'

/**
 * Settings → Connections. Each member's own connections — one group per
 * provider with an OAuth client, its product row carrying Connect — then,
 * for an admin, one OAuth client group per provider: redirect URI, client id
 * and a write-only secret. The secret never reaches the page: a stored one
 * reads as its `redact()` tail, and saving with the field empty keeps it.
 */
export function ConnectionsSection({
  apps,
  configured,
}: {
  /** Null for a member: the OAuth clients are the admin's. */
  apps: ReadonlyArray<ProviderAppRow> | null
  /** Providers with an active OAuth client; the rest draw nothing to click. */
  configured: ReadonlyArray<ProviderId>
}) {
  return (
    <SettingsSection title="Connections" crumb="Data & AI">
      {configured.length === 0 ? (
        <div className="flex flex-col pt-8">
          <p className="flex min-h-12 items-center border-b border-rule px-3 text-ui text-graphite">
            No connections.
          </p>
        </div>
      ) : (
        configured.map((provider) => (
          <ProviderGroup key={provider} provider={provider} />
        ))
      )}
      {apps?.map((app) => (
        <OAuthClientGroup key={app.provider} app={app} />
      ))}
    </SettingsSection>
  )
}

/**
 * One provider's products. Connect leaves for the provider's own consent
 * screen through the start route — a full navigation, not a fetch.
 */
function ProviderGroup({ provider }: { provider: ProviderId }) {
  const productId = CONNECT_PRODUCT[provider]
  const product = productOf(provider, productId)
  if (product === null) return null
  return (
    <div className="flex flex-col pt-8">
      <SectionHead as="h3" title={PROVIDERS[provider].label} />
      <div className="flex min-h-12 items-center gap-3.5 border-b border-rule px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-ui text-foreground">{product.name}</span>
          <span className="truncate mono text-micro text-graphite">
            {productScopes(provider, productId).join(' · ')}
          </span>
        </div>
        <Button size="sm" variant="outline" asChild>
          <a
            href={connectHref(provider, productId)}
            aria-label={`Connect ${product.label}`}
          >
            Connect
          </a>
        </Button>
      </div>
    </div>
  )
}

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
    <div className="flex flex-col pt-8">
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
