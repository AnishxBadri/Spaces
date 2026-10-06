import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  DropDataOption,
  SECRET_GROUPS,
  SecretFieldRow,
  SettingsFields,
  WebhookUrlRow,
} from '#/components/integrations/integration-settings'
import {
  STATE_WORD,
  creditsOf,
} from '#/components/integrations/integration-ledger'
import { SectionHead } from '#/components/ledger-section'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Switch } from '#/components/ui/switch'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  getIntegration,
  getSession,
  removeIntegrationSecret,
  resetIntegration,
  saveIntegrationSecret,
  saveIntegrationSettings,
  setIntegrationEnabled,
  uninstallIntegration,
  updateIntegration,
} from '#/lib/server-fns'
import type {
  FormValue,
  IntegrationDetail,
  SecretField,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * One plugin's card: its state, its key and its settings, generated from the
 * manifest the worker stored. Inside the settings shell, so Integrations
 * stays lit; the `_` keeps it out of the ledger's component.
 */
export const Route = createFileRoute(
  '/_app/settings/integrations_/$integrationId',
)({
  loader: async ({ params }) => {
    const session = await getSession()
    if (session?.user.role !== 'admin') return { detail: null }
    return {
      detail: await getIntegration({ data: { id: params.integrationId } }),
    }
  },
  component: IntegrationPage,
})

function IntegrationPage() {
  const { detail } = Route.useLoaderData()
  if (detail === null)
    return (
      <SettingsSection title="Integrations" crumb="Data & AI">
        <SettingsRow
          label="Admins only"
          hint="Plugins and their keys belong to the workspace admin."
        />
      </SettingsSection>
    )
  // Keyed on the row so a reload after a save starts the form from the stored config.
  return <IntegrationCard key={detail.id} detail={detail} />
}

/** The mono meta line under the title: version, state, last run, credits. */
function metaOf(detail: IntegrationDetail): string {
  return [
    detail.pluginId,
    detail.version,
    STATE_WORD[detail.state],
    detail.lastRun ? `ran ${detail.lastRun.ago}` : 'never ran',
    `${creditsOf(detail)} today`,
  ].join(' · ')
}

function IntegrationCard({ detail }: { detail: IntegrationDetail }) {
  const router = useRouter()
  const navigate = useNavigate()
  const dropData = useRef(false)
  const { confirm, confirmDialog } = useConfirm()
  const [pending, setPending] = useState(false)
  const [values, setValues] = useState(detail.values)
  const [errors, setErrors] = useState<{ readonly [key: string]: string }>({})
  const [dirty, setDirty] = useState(false)
  const [secrets, setSecrets] = useState<{ [slot: string]: string }>({})

  async function act(run: () => Promise<unknown>, done: string) {
    setPending(true)
    try {
      await run()
      toast(done)
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  async function saveSettings() {
    setPending(true)
    try {
      const saved = await saveIntegrationSettings({
        data: { id: detail.id, values },
      })
      if (!saved.ok) {
        setErrors(saved.errors)
        return
      }
      setErrors({})
      setDirty(false)
      toast(`${detail.name} settings saved · reloading`)
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  function change(key: string, value: FormValue) {
    setValues((v) => ({ ...v, [key]: value }))
    setDirty(true)
  }

  async function uninstall() {
    dropData.current = false
    const ok = await confirm({
      title: `Uninstall ${detail.name}?`,
      body: (
        <>
          Its files and its key are deleted. What it filled stays, marked as
          filled by {detail.name}, since removed.
          <DropDataOption
            onChange={(next) => {
              dropData.current = next
            }}
          />
        </>
      ),
      action: 'Uninstall',
    })
    if (!ok) return
    setPending(true)
    try {
      await uninstallIntegration({
        data: { id: detail.id, dropData: dropData.current },
      })
      toast(`${detail.name} uninstalled`)
      await navigate({ to: '/settings/integrations' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not uninstall')
      setPending(false)
    }
  }

  function secretRow(field: SecretField) {
    return (
      <SecretFieldRow
        key={field.slot}
        field={field}
        value={secrets[field.slot] ?? ''}
        disabled={pending}
        onChange={(v) => setSecrets((s) => ({ ...s, [field.slot]: v }))}
        onSave={() =>
          void act(async () => {
            const { display } = await saveIntegrationSecret({
              data: {
                id: detail.id,
                slot: field.slot,
                secret: secrets[field.slot] ?? '',
              },
            })
            setSecrets((s) => ({ ...s, [field.slot]: '' }))
            return display
          }, `${field.label} saved · reloading`)
        }
        onRemove={() =>
          void confirm({
            title: `Remove the ${field.label}?`,
            body:
              field.slot === 'webhook'
                ? `${detail.name} refuses webhook deliveries until a new secret is saved.`
                : `${detail.name} stops until a new key is saved.`,
            action: 'Remove',
          }).then((ok) => {
            if (ok)
              void act(
                () =>
                  removeIntegrationSecret({
                    data: { id: detail.id, slot: field.slot },
                  }),
                `${field.label} removed`,
              )
          })
        }
      />
    )
  }

  const tripped = detail.state === 'tripped'
  return (
    <SettingsSection
      title={detail.name}
      blurb={detail.description}
      crumb="Data & AI"
      action={
        <>
          {tripped ? (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void act(
                  () => resetIntegration({ data: { id: detail.id } }),
                  `${detail.name} reset · reloading`,
                )
              }
            >
              Reset
            </Button>
          ) : null}
          {detail.update !== null ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void act(
                  () => updateIntegration({ data: { id: detail.id } }),
                  `${detail.name} updated to ${detail.update ?? ''} · reloading`,
                )
              }
            >
              Update to {detail.update}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void uninstall()}
          >
            Uninstall
          </Button>
          <Switch
            checked={detail.enabled}
            disabled={pending}
            onCheckedChange={(enabled) =>
              void act(
                () =>
                  setIntegrationEnabled({ data: { id: detail.id, enabled } }),
                enabled ? `${detail.name} on` : `${detail.name} off · key kept`,
              )
            }
          >
            {detail.enabled ? 'On' : 'Off'}
          </Switch>
        </>
      }
    >
      <p className="px-3 pt-3 mono text-micro text-graphite">
        {metaOf(detail)}
      </p>
      {detail.state === 'degraded' || tripped ? (
        <div
          role="status"
          className={cn(
            'mt-3 flex flex-col gap-1 border-y border-rule px-3 py-2',
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

      {SECRET_GROUPS.map(({ slot, title }) => {
        const fields = detail.secrets.filter((s) => s.slot === slot)
        const url = slot === 'webhook' ? detail.webhookUrl : null
        if (fields.length === 0 && url === null) return null
        return (
          <div key={slot} className="flex flex-col pt-8">
            <SectionHead
              as="h3"
              title={fields.length === 0 ? 'Webhook' : title}
              count={
                fields.length === 0
                  ? null
                  : fields.every((s) => s.display !== null)
                    ? 'saved'
                    : 'not yet'
              }
            />
            {url !== null ? <WebhookUrlRow url={url} /> : null}
            {fields.map(secretRow)}
          </div>
        )
      })}

      <SettingsFields
        form={detail.form}
        values={values}
        errors={errors}
        disabled={pending}
        dirty={dirty}
        onChange={change}
        onSave={() => void saveSettings()}
      />
      {confirmDialog}
    </SettingsSection>
  )
}
