import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useSettingsDraft } from '#/components/settings/settings-form'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Input } from '#/components/ui/input'
import { saveWorkspace, setBaseCurrency } from '#/lib/server-fns'

const shell = getRouteApi('/_app/settings')

/**
 * The workspace singleton: its name and the currency it prices in. (D81)
 * - Both are typed fields: they collect into the page's Save bar.
 * - Only an admin changes them; a member reads them disabled.
 */
export const Route = createFileRoute('/_app/settings/general')({
  component: GeneralRoute,
})

function GeneralRoute() {
  const data = shell.useLoaderData()
  return (
    <SettingsSection title="General" crumb="Workspace" adminOnly>
      <WorkspaceNameRow name={data.workspace?.name ?? ''} />
      <BaseCurrencyRow baseCurrency={data.fx.baseCurrency} />
    </SettingsSection>
  )
}

function WorkspaceNameRow({ name }: { name: string }) {
  const router = useRouter()
  const { draft, set } = useSettingsDraft({ name }, async (next) => {
    const trimmed = next.name.trim()
    if (trimmed === '') throw new Error('The workspace needs a name.')
    await saveWorkspace({ data: { name: trimmed } })
    toast('Workspace renamed')
    void router.invalidate()
    return { name: trimmed }
  })

  return (
    <SettingsRow label="Name">
      <Input
        id="ws-name"
        aria-label="Workspace name"
        value={draft.name}
        onChange={(e) => set('name', e.target.value)}
        placeholder="Your fund's name"
        className="w-56"
      />
    </SettingsRow>
  )
}

/** The currency every holding is priced in; the rates live in Currency & FX. */
function BaseCurrencyRow({ baseCurrency }: { baseCurrency: string }) {
  const router = useRouter()
  const { draft, set } = useSettingsDraft(
    { currency: baseCurrency },
    async (next) => {
      const currency = next.currency.trim().toUpperCase()
      await setBaseCurrency({ data: { currency } })
      toast('Base currency saved')
      void router.invalidate()
      return { currency }
    },
  )

  return (
    <SettingsRow
      label="Base currency"
      hint="Changing it re-prices the portfolio strip; ledgers keep their original currency."
    >
      <Input
        id="fx-base"
        aria-label="Base currency"
        value={draft.currency}
        onChange={(e) => set('currency', e.target.value)}
        maxLength={3}
        className="w-24 mono uppercase"
      />
    </SettingsRow>
  )
}
