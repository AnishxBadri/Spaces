import {
  createFileRoute,
  getRouteApi,
  Link,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { SectionHead } from '#/components/ledger-section'
import { useSettingsDraft } from '#/components/settings/settings-form'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { Input } from '#/components/ui/input'
import {
  getDemoSummary,
  getWhatsSetUp,
  removeDemoData,
  saveWorkspace,
  setBaseCurrency,
} from '#/lib/server-fns'
import type { DemoSummary } from '#/lib/server-fns'
import { SETUP_ITEMS } from '#/lib/setup/whats-set-up'
import type { SetupState } from '#/lib/setup/whats-set-up'

const shell = getRouteApi('/_app/settings')

/**
 * The workspace singleton: its name and the currency it prices in, the demo
 * while it is loaded, and What's set up at the foot. (D80, D81)
 * - Name and currency are typed fields: they collect into the page's Save bar.
 * - Only an admin changes them; a member reads them disabled.
 */
export const Route = createFileRoute('/_app/settings/general')({
  loader: async () => {
    const [demo, setUp] = await Promise.all([getDemoSummary(), getWhatsSetUp()])
    return { demo, setUp }
  },
  component: GeneralRoute,
})

function GeneralRoute() {
  const data = shell.useLoaderData()
  const { demo, setUp } = Route.useLoaderData()
  return (
    <SettingsSection title="General" crumb="Workspace" adminOnly>
      <WorkspaceNameRow name={data.workspace?.name ?? ''} />
      <BaseCurrencyRow baseCurrency={data.fx.baseCurrency} />
      {demo === null ? null : <DemoDataRow demo={demo} />}
      <WhatsSetUp state={setUp} />
    </SettingsSection>
  )
}

const KIND_WORDS: ReadonlyArray<[keyof DemoSummary['byKind'], string, string]> =
  [
    ['company', 'company', 'companies'],
    ['person', 'person', 'people'],
    ['space', 'space', 'spaces'],
    ['term', 'glossary term', 'glossary terms'],
    ['note', 'note', 'notes'],
  ]

/** `3 companies · 1 person · 3 spaces`, the demo's records still standing. */
function demoCounts(demo: DemoSummary): Array<string> {
  return KIND_WORDS.flatMap(([kind, one, many]) => {
    const n = demo.byKind[kind] ?? 0
    return n === 0 ? [] : [`${n} ${n === 1 ? one : many}`]
  })
}

/** The demo, removable in one step; absent once removed. (D80) */
function DemoDataRow({ demo }: { demo: DemoSummary }) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [pending, setPending] = useState(false)
  const counts = demoCounts(demo)

  async function remove() {
    const ok = await confirm({
      title: 'Remove the demo data?',
      body: 'Deletes the records the demo loaded. Anything added since stays.',
      rows: counts.map((c) => ({ name: c })),
      action: 'Remove demo data',
    })
    if (!ok) return
    setPending(true)
    try {
      const { removed, kept } = await removeDemoData()
      toast(
        kept === 0
          ? `Demo data removed · ${removed} records`
          : `Demo data removed · ${removed} records · ${kept} kept in use`,
      )
      void router.invalidate()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not remove the demo data',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsRow
      label="Demo data"
      hint={counts.length === 0 ? 'Nothing left' : counts.join(' · ')}
    >
      <Button variant="outline" pending={pending} onClick={() => void remove()}>
        Remove demo data
      </Button>
      {confirmDialog}
    </SettingsRow>
  )
}

/** The seven pieces a workspace can bring, passive: state, what it unlocks, a link. (D80) */
function WhatsSetUp({ state }: { state: SetupState }) {
  const set = SETUP_ITEMS.filter((item) => state[item.id]).length
  return (
    <div className="flex flex-col pt-8">
      <SectionHead
        as="h3"
        title="What's set up"
        count={`${set} of ${SETUP_ITEMS.length}`}
      />
      {SETUP_ITEMS.map((item) => (
        <SettingsRow key={item.id} label={item.label} hint={item.unlocks}>
          <span className="mono text-micro text-graphite">
            {state[item.id] ? 'set' : 'not set'}
          </span>
          <Link
            to={item.to}
            className="focus-ring mono text-micro text-primary hover:underline"
          >
            {state[item.id] ? 'Open' : 'Set up'} ›
          </Link>
        </SettingsRow>
      ))}
    </div>
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
