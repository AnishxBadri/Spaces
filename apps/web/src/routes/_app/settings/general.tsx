import {
  createFileRoute,
  getRouteApi,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check } from '#/components/icons'
import { useSettingsDraft } from '#/components/settings/settings-form'
import {
  SETTINGS_LINK,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { WorkspaceMark } from '#/components/workspace-mark'
import { baseCurrencyCodes, currencyLabel } from '#/lib/currency-names'
import {
  clearWorkspaceLogo,
  getDemoSummary,
  getWhatsSetUp,
  removeDemoData,
  saveWorkspace,
  setBaseCurrency,
  setWorkspaceLogo,
} from '#/lib/server-fns'
import type { DemoSummary } from '#/lib/server-fns'
import { SETUP_ITEMS } from '#/lib/setup/whats-set-up'
import type { SetupState } from '#/lib/setup/whats-set-up'
import { cn } from '#/lib/utils'

const shell = getRouteApi('/_app/settings')

/**
 * The workspace singleton: Identity (the logo tile and the name, one row),
 * Defaults (the currency it prices in), the demo while it is loaded, and
 * Setup at the foot until every piece is set up.
 * - Name and currency are drafts: they collect into the page's Save bar.
 * - The logo's Upload and Remove write at once, with a toast.
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
    <SettingsSection title="General" adminOnly>
      <SettingsGroup title="Identity">
        <IdentityRow
          name={data.workspace?.name ?? ''}
          logo={data.workspace?.logo ?? null}
        />
      </SettingsGroup>
      <SettingsGroup title="Defaults">
        <BaseCurrencyRow baseCurrency={data.fx.baseCurrency} />
      </SettingsGroup>
      {demo === null ? null : <DemoDataRow demo={demo} />}
      <Setup state={setUp} />
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

/** The demo, removable in one step; absent once removed. */
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
    <SettingsGroup title="Demo data">
      <SettingsRow label="Loaded">
        <span className="mono text-micro text-graphite">
          {counts.length === 0 ? 'nothing left' : counts.join(' · ')}
        </span>
        <Button
          variant="outline"
          pending={pending}
          onClick={() => void remove()}
        >
          Remove demo data
        </Button>
        {confirmDialog}
      </SettingsRow>
    </SettingsGroup>
  )
}

/**
 * The seven pieces a workspace can bring: each row opens its page, its end
 * lane a tick when set up or `Set up ›` when not. Unfinished rows lead,
 * each run in its own order; with all seven set up the card is gone.
 */
function Setup({ state }: { state: SetupState }) {
  const navigate = useNavigate()
  const set = SETUP_ITEMS.filter((item) => state[item.id]).length
  if (set === SETUP_ITEMS.length) return null
  const rows = [
    ...SETUP_ITEMS.filter((item) => !state[item.id]),
    ...SETUP_ITEMS.filter((item) => state[item.id]),
  ]
  return (
    <SettingsGroup title="Setup" count={`${set} of ${SETUP_ITEMS.length}`}>
      {/* The one line each item unlocks is the item itself, not a hint. */}
      {rows.map((item) => (
        <SettingsRow
          key={item.id}
          label={item.label}
          hint={item.unlocks}
          onOpen={() => void navigate({ to: item.to })}
          end={
            state[item.id] ? (
              <Check
                data-setup-done
                aria-label="Set up"
                className="size-4 text-primary"
                strokeWidth={2}
              />
            ) : (
              <Link to={item.to} className={SETTINGS_LINK}>
                Set up ›
              </Link>
            )
          }
        />
      ))}
    </SettingsGroup>
  )
}

const LOGO_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml'

/**
 * Identity in one row: the 64px logo tile, the name beside it, and a quiet
 * Remove at the end while a logo is held.
 * - The tile is the upload control: a click opens the file picker, a dropped
 *   image uploads; hover and focus name the act.
 * - The logo writes at once with a toast; the name joins the Save bar.
 */
function IdentityRow({ name, logo }: { name: string; logo: string | null }) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<'upload' | 'remove' | null>(null)
  const [over, setOver] = useState(false)
  const { draft, set } = useSettingsDraft({ name }, async (next) => {
    const trimmed = next.name.trim()
    if (trimmed === '') throw new Error('The workspace needs a name.')
    await saveWorkspace({ data: { name: trimmed } })
    toast('Workspace renamed')
    void router.invalidate()
    return { name: trimmed }
  })

  async function run(
    kind: 'upload' | 'remove',
    write: () => Promise<unknown>,
    done: string,
    failed: string,
  ) {
    setPending(kind)
    try {
      await write()
      toast(done)
      await router.invalidate()
    } catch (err) {
      toast.error(
        err instanceof Error && err.message !== '' ? err.message : failed,
      )
    } finally {
      setPending(null)
    }
  }

  function upload(file: File) {
    const form = new FormData()
    form.set('file', file)
    void run(
      'upload',
      () => setWorkspaceLogo({ data: form }),
      'Logo saved',
      'Could not save the logo',
    )
  }

  const act = logo === null ? 'Upload' : 'Replace'
  return (
    <div
      data-settings-row
      data-identity-row
      className="flex min-h-12 items-center gap-6 border-b border-rule px-(--inset) py-3"
    >
      <button
        type="button"
        data-logo-tile
        aria-label={`${act} logo`}
        title={act}
        disabled={pending !== null}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const file = e.dataTransfer.files.item(0)
          if (file) upload(file)
        }}
        className={cn(
          'group/tile focus-ring relative size-16 shrink-0 rounded-none outline outline-1 outline-rule disabled:cursor-default',
          over && 'outline-primary',
        )}
      >
        <WorkspaceMark name={name} logo={logo} size={64} />
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 flex items-center justify-center bg-paper/90 text-label text-foreground opacity-0 transition-opacity duration-150 ease-out-quart group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100 group-disabled/tile:opacity-0',
            (over || pending === 'upload') && 'opacity-100',
          )}
        >
          {pending === 'upload' ? 'Saving…' : act}
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor="ws-name" className="text-label text-graphite">
          Name
        </label>
        <Input
          id="ws-name"
          aria-label="Workspace name"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Your fund's name"
          className="w-70"
        />
      </div>
      {logo === null ? null : (
        <div data-settings-end className="flex shrink-0 items-center">
          <button
            type="button"
            disabled={pending !== null}
            onClick={() =>
              void run(
                'remove',
                () => clearWorkspaceLogo(),
                'Logo removed',
                'Could not remove the logo',
              )
            }
            className="focus-ring rounded-md text-label text-graphite hover:text-foreground hover:underline disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept={LOGO_ACCEPT}
        aria-label="Logo file"
        className="hidden"
        onChange={(e) => {
          const file = e.currentTarget.files?.item(0)
          e.currentTarget.value = ''
          if (file) upload(file)
        }}
      />
    </div>
  )
}

/** The currency every holding is priced in; the rates live in Currency & FX. */
function BaseCurrencyRow({ baseCurrency }: { baseCurrency: string }) {
  const router = useRouter()
  const { draft, set } = useSettingsDraft(
    { currency: baseCurrency },
    async (next) => {
      await setBaseCurrency({ data: { currency: next.currency } })
      toast('Base currency saved')
      void router.invalidate()
      return next
    },
  )

  return (
    <SettingsRow label="Base currency">
      <Select
        id="fx-base"
        aria-label="Base currency"
        value={draft.currency}
        onChange={(code) => set('currency', code)}
        items={baseCurrencyCodes(baseCurrency).map((code) => ({
          value: code,
          label: currencyLabel(code),
        }))}
        width="trigger"
        className="w-60"
      />
    </SettingsRow>
  )
}
