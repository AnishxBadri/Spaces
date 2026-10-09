import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { saveWorkspace, setBaseCurrency } from '#/lib/server-fns'

const shell = getRouteApi('/_app/settings')

/** The workspace singleton: its name and the currency it prices in. (D81) */
export const Route = createFileRoute('/_app/settings/general')({
  component: GeneralRoute,
})

function GeneralRoute() {
  const data = shell.useLoaderData()
  return (
    <SettingsSection title="General" crumb="Workspace">
      <WorkspaceNameRow
        name={data.workspace?.name ?? ''}
        isAdmin={data.isAdmin}
      />
      <BaseCurrencyRow
        baseCurrency={data.fx.baseCurrency}
        isAdmin={data.isAdmin}
      />
    </SettingsSection>
  )
}

function WorkspaceNameRow({
  name,
  isAdmin,
}: {
  name: string
  isAdmin: boolean
}) {
  const router = useRouter()
  const [value, setValue] = useState(name)
  const [pending, setPending] = useState(false)
  const dirty = value.trim() !== name && value.trim().length > 0

  async function save() {
    setPending(true)
    try {
      await saveWorkspace({ data: { name: value.trim() } })
      toast.success('Workspace renamed')
      void router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not rename')
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsRow
      label="Name"
      hint={
        isAdmin
          ? 'Shown to every member.'
          : 'Only admins can rename the workspace.'
      }
    >
      <Input
        id="ws-name"
        aria-label="Workspace name"
        value={value}
        disabled={!isAdmin}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Your fund's name"
        className="w-56"
      />
      {isAdmin ? (
        <Button size="sm" disabled={!dirty || pending} onClick={save}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      ) : null}
    </SettingsRow>
  )
}

/** The currency every holding is priced in; the rates live in Currency & FX. */
function BaseCurrencyRow({
  baseCurrency,
  isAdmin,
}: {
  baseCurrency: string
  isAdmin: boolean
}) {
  const router = useRouter()
  const [base, setBase] = useState(baseCurrency)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const next = base.trim().toUpperCase()

  async function save() {
    if (next === baseCurrency) return
    setPending(true)
    setError(null)
    try {
      await setBaseCurrency({ data: { currency: next } })
      toast('Base currency saved')
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsRow
      label="Base currency"
      hint={
        error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : (
          'Changing it re-prices the portfolio strip; ledgers keep their original currency.'
        )
      }
    >
      <Input
        id="fx-base"
        aria-label="Base currency"
        value={base}
        onChange={(e) => setBase(e.target.value)}
        maxLength={3}
        className="w-24 mono uppercase"
        disabled={!isAdmin}
      />
      {isAdmin && next !== baseCurrency ? (
        <Button size="sm" onClick={save} disabled={pending}>
          Save
        </Button>
      ) : null}
    </SettingsRow>
  )
}
