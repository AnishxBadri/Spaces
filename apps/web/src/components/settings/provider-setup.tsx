import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { useSettingsDraft } from './settings-form'
import { SettingsGroupHead, SettingsRow } from './settings-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Segmented } from '#/components/ui/segmented'
import { useClock } from '#/components/clock'
import { formatDay } from '@spaces/core/format'
import type { ProviderId } from '@spaces/core/providers/registry'
import { connectHref } from '#/lib/connections/products'
import { consentFor } from '#/lib/connections/provider-view'
import type {
  ConsentType,
  GoogleAudience,
  ProviderAppRow,
  ProviderPageView,
} from '#/lib/server-fns'
import { setProviderApp, setProviderChoice } from '#/lib/server-fns'

const LINK =
  'focus-ring rounded-md text-label text-graphite hover:text-foreground'

const AUDIENCE_COPY: Record<GoogleAudience, string> = {
  workspace:
    'A company domain on Google Workspace. Members connect once and stay connected.',
  personal:
    'Google keeps an unverified app in Testing: each member reconnects every 7 days, forever. Verification needs a paid security review per app.',
}

const CONSENT_HINT: Record<ConsentType, string> = {
  internal: 'Only accounts on your Workspace domain can connect.',
  external:
    'Any Google account can connect. Google holds the app in Testing until it is verified.',
}

/** Where each provider's console is, for its first steps. */
const CONSOLE: Record<
  ProviderId,
  ReadonlyArray<{
    readonly title: string
    readonly href: string
    readonly link: string
  }>
> = {
  google: [
    {
      title: 'Create a Google Cloud project',
      href: 'https://console.cloud.google.com/projectcreate',
      link: 'Open Google Cloud ↗',
    },
    {
      title: 'Turn on the Gmail, Calendar and Drive APIs',
      href: 'https://console.cloud.google.com/apis/library',
      link: 'Open the API library ↗',
    },
  ],
  box: [
    {
      title: 'Create a Box app with user authentication',
      href: 'https://app.box.com/developers/console',
      link: 'Open the Box console ↗',
    },
  ],
}

/** A step's label lane: its number in mono, then the step. */
function Step({ n, children }: { n: number | null; children: ReactNode }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="w-3 shrink-0 mono text-micro text-graphite">
        {n === null ? '' : String(n)}
      </span>
      <span>{children}</span>
    </span>
  )
}

/**
 * A provider's Set up tab: for Google, whether the accounts are on Workspace
 * or personal Gmail; then the numbered steps through its console, the
 * redirect address, the OAuth client (one draft in the page's Save bar) and
 * a test connect. Choices apply at once; the client waits for Save.
 */
export function ProviderSetup({ view }: { view: ProviderPageView }) {
  const { app, choices } = view
  const router = useRouter()
  const consoleSteps = CONSOLE[app.provider]
  const audience = choices?.audience ?? 'workspace'
  const consent = choices?.consent ?? consentFor(audience)

  async function choose(change: {
    audience?: GoogleAudience
    consent?: ConsentType
  }) {
    try {
      await setProviderChoice({ data: { provider: 'google', ...change } })
      toast('Saved')
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    }
  }

  // Steps number themselves: Box asks no audience and has no consent step.
  let n = 0
  const nextStep = () => (n += 1)
  return (
    <div className="flex flex-col">
      {choices !== null ? (
        <SettingsRow label="Your accounts are on">
          <Segmented
            label="Your accounts are on"
            value={audience}
            options={[
              { id: 'workspace', label: 'Google Workspace' },
              { id: 'personal', label: 'Personal Gmail' },
            ]}
            onChange={(next) =>
              void choose({ audience: next, consent: consentFor(next) })
            }
          />
          <p className="basis-full text-label text-graphite">
            {AUDIENCE_COPY[audience]}
          </p>
          {audience === 'personal' ? (
            <p className="basis-full text-label text-graphite">
              Email only? Forwarding needs no Google app.{' '}
              <Link to="/settings/email-forwarding" className={LINK}>
                Email forwarding ›
              </Link>
            </p>
          ) : null}
        </SettingsRow>
      ) : null}
      <SettingsGroupHead title="Steps" />
      {consoleSteps.map((step) => (
        <SettingsRow
          key={step.title}
          label={<Step n={nextStep()}>{step.title}</Step>}
        >
          <a href={step.href} target="_blank" rel="noreferrer" className={LINK}>
            {step.link}
          </a>
        </SettingsRow>
      ))}
      {choices !== null ? (
        <SettingsRow label={<Step n={nextStep()}>Consent screen</Step>}>
          <Segmented
            label="Consent screen"
            value={consent}
            options={[
              { id: 'internal', label: 'Internal' },
              { id: 'external', label: 'External' },
            ]}
            onChange={(next) => void choose({ consent: next })}
          />
          <p className="basis-full text-label text-graphite">
            {CONSENT_HINT[consent]}
          </p>
        </SettingsRow>
      ) : null}
      <RedirectRow n={nextStep()} uri={app.redirectUri} />
      <OAuthClientRows n={nextStep()} app={app} />
      <TestRow n={nextStep()} view={view} />
    </div>
  )
}

/** `https://deals.fund.example/api/…/callback` → `/api/…/callback`. */
export function pathOf(uri: string): string {
  const at = uri.indexOf('/', uri.indexOf('//') + 2)
  return at === -1 ? uri : uri.slice(at)
}

/**
 * Where the provider sends people back; Copy takes the whole address, pasted
 * into its console as-is. The row prints the path the code answers on; the
 * origin is the title.
 */
function RedirectRow({ n, uri }: { n: number; uri: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <SettingsRow label={<Step n={n}>Redirect address</Step>}>
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

/**
 * The client id and a write-only secret as one draft in the page's Save bar.
 * A stored value reads as text with Edit or Replace; the field opens only
 * when asked. The secret settles empty after a save.
 */
function OAuthClientRows({ n, app }: { n: number; app: ProviderAppRow }) {
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
    <>
      <SettingsRow label={<Step n={n}>Client ID</Step>}>
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
      <SettingsRow label={<Step n={null}>Client secret</Step>}>
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
    </>
  )
}

/**
 * Connects the reader's own account through the client, consenting to the
 * first use that is switched on, and lands back here. A live account of the
 * reader's under the provider reads `■ Works · <email>`.
 */
function TestRow({ n, view }: { n: number; view: ProviderPageView }) {
  const first = view.uses.find((u) => u.enabled && u.integrationId !== null)
  return (
    <SettingsRow label={<Step n={n}>Test</Step>}>
      {!view.app.configured ? (
        <span className="text-label text-graphite">
          Once the client is saved
        </span>
      ) : first === undefined ? (
        <span className="text-label text-graphite">
          Once a use is on in In use
        </span>
      ) : (
        <Button size="sm" variant="outline" asChild>
          <a
            href={connectHref(
              view.app.provider,
              first.product,
              [],
              `/settings/connections/${view.app.provider}?tab=setup`,
            )}
          >
            Connect my account to test
          </a>
        </Button>
      )}
      {view.mine === null ? null : (
        <span className="flex items-center gap-2 mono text-micro text-foreground">
          <span aria-hidden className="size-1.5 shrink-0 bg-primary" />
          Works · {view.mine}
        </span>
      )}
    </SettingsRow>
  )
}
