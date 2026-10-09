import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AutoEnrichFields,
  DropDataOption,
  SECRET_GROUPS,
  SecretFieldRow,
  SettingsFields,
  WebhookUrlRow,
} from '#/components/integrations/integration-settings'
import { PluginTemplate } from '#/components/integrations/plugin-template'
import { useSettingsDraft } from '#/components/settings/settings-form'
import { SettingsSection } from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  getIntegration,
  removeIntegrationSecret,
  resetIntegration,
  saveIntegrationAutoEnrich,
  saveIntegrationSecret,
  saveIntegrationSettings,
  setIntegrationEnabled,
  uninstallIntegration,
  updateIntegration,
} from '#/lib/server-fns'
import type {
  FormValue,
  FormValues,
  IntegrationDetail,
  SecretField,
  SettingsField,
} from '#/lib/server-fns'

/**
 * One plugin's page, on the one template every plugin shares
 * (`PluginTemplate`): status, key, what it sends, its manifest settings,
 * what it switches on, recent runs, Disable / Uninstall. Inside the settings
 * shell, so Plugins stays lit; the `_` keeps it out of the ledger's
 * component. A member reads it too, keys redacted and every control
 * disabled. (D81)
 */
export const Route = createFileRoute('/_app/settings/plugins_/$integrationId')({
  loader: async ({ params }) => ({
    detail: await getIntegration({ data: { id: params.integrationId } }),
  }),
  component: IntegrationPage,
})

function IntegrationPage() {
  const { detail } = Route.useLoaderData()
  return <IntegrationCard key={detail.id} detail={detail} />
}

function IntegrationCard({ detail }: { detail: IntegrationDetail }) {
  const router = useRouter()
  const navigate = useNavigate()
  const dropData = useRef(false)
  const { confirm, confirmDialog } = useConfirm()
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<{ readonly [key: string]: string }>({})

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

  /** Writes the stored config with `changes` over it; a refusal marks its rows. */
  async function writeSettings(changes: FormValues, done: string) {
    const saved = await saveIntegrationSettings({
      data: { id: detail.id, values: { ...detail.values, ...changes } },
    })
    if (!saved.ok) {
      setErrors(saved.errors)
      throw new Error(`${detail.name} settings not saved`)
    }
    setErrors({})
    toast(done)
    await router.invalidate()
  }

  // Typed settings (a string, a number) are one draft in the Save bar.
  const typed = detail.form.ok
    ? detail.form.fields.filter(
        (f) => f.kind === 'string' || f.kind === 'number',
      )
    : []
  const settings = useSettingsDraft(
    Object.fromEntries(
      typed.map((f) => {
        const v = Object.hasOwn(detail.values, f.key)
          ? detail.values[f.key]
          : undefined
        return [f.key, typeof v === 'string' ? v : '']
      }),
    ),
    (next) => writeSettings(next, `${detail.name} settings saved · reloading`),
  )

  // A switch or a picker saves alone, against the stored config.
  function change(field: SettingsField, value: FormValue) {
    if (field.kind === 'string' || field.kind === 'number') {
      if (typeof value === 'string') settings.set(field.key, value)
      return
    }
    setPending(true)
    writeSettings({ [field.key]: value }, `${field.label} saved`)
      .catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : 'Could not save'),
      )
      .finally(() => setPending(false))
  }

  // Each secret slot's field is write-only; the draft settles empty.
  const secrets = useSettingsDraft(
    Object.fromEntries(detail.secrets.map((f) => [f.slot, ''])),
    async (next) => {
      for (const field of detail.secrets) {
        const secret = Object.hasOwn(next, field.slot) ? next[field.slot] : ''
        if (secret.trim() === '') continue
        await saveIntegrationSecret({
          data: { id: detail.id, slot: field.slot, secret },
        })
        toast(`${field.label} saved · reloading`)
      }
      await router.invalidate()
      return Object.fromEntries(detail.secrets.map((f) => [f.slot, '']))
    },
  )

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
      await navigate({ to: '/settings/plugins' })
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
        value={
          Object.hasOwn(secrets.draft, field.slot)
            ? secrets.draft[field.slot]
            : ''
        }
        disabled={pending}
        onChange={(v) => secrets.set(field.slot, v)}
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
  const keyRows = SECRET_GROUPS.flatMap(({ slot }) => {
    const fields = detail.secrets.filter((f) => f.slot === slot)
    const url = slot === 'webhook' ? detail.webhookUrl : null
    return [
      ...(url === null ? [] : [<WebhookUrlRow key="webhook-url" url={url} />]),
      ...fields.map(secretRow),
    ]
  })
  const hasSettings =
    !detail.form.ok ||
    detail.form.fields.length > 0 ||
    detail.autoEnrichForm !== null
  return (
    <SettingsSection
      title={detail.name}
      blurb={detail.description}
      crumb="Integrations"
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
        </>
      }
    >
      <PluginTemplate
        detail={detail}
        keyBlock={keyRows.length === 0 ? null : keyRows}
        settingsBlock={
          hasSettings ? (
            <>
              <SettingsFields
                form={detail.form}
                values={{ ...detail.values, ...settings.draft }}
                errors={errors}
                disabled={pending}
                notYet={detail.state === 'needs-setup'}
                onChange={change}
              />
              {detail.autoEnrichForm !== null ? (
                <AutoEnrichFields
                  key={[
                    ...detail.autoEnrichForm.scopes,
                    ...detail.autoEnrichForm.spaces,
                  ].join()}
                  view={detail.autoEnrichForm}
                  disabled={pending}
                  onSave={(scope) =>
                    void act(
                      () =>
                        saveIntegrationAutoEnrich({
                          data: { id: detail.id, ...scope },
                        }),
                      `${detail.name} auto-enrich saved`,
                    )
                  }
                />
              ) : null}
            </>
          ) : null
        }
        pending={pending}
        onToggle={(enabled) =>
          void act(
            () => setIntegrationEnabled({ data: { id: detail.id, enabled } }),
            enabled ? `${detail.name} on` : `${detail.name} off · key kept`,
          )
        }
        onUninstall={() => void uninstall()}
      />
      {confirmDialog}
    </SettingsSection>
  )
}
