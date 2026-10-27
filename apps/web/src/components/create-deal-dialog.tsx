import { useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  liveOptions,
  optionLabel,
  ValueEditor,
} from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import {
  filledValues,
  MoreFields,
  RegistryField,
  withTodayDates,
} from '#/components/create-window'
import { useClock } from '#/components/clock'
import { TemplatePicker } from '#/components/templates'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { createDeal, getCompany, updateRecord } from '#/lib/server-fns'
import { composeDealName } from '#/lib/deals/deal-name'
import { useHotkey } from '#/lib/use-hotkey'
import { jsonRecord } from '@spaces/core/json'

/** The judgment fields worth setting at birth; refs and owner stay on the record. */
const MORE_SLUGS = ['value', 'source', 'close_date']

/**
 * The New deal window: the company and the stage. The name is composed
 * from the two (`<Company> — <Stage>`) until someone types one, under
 * `More fields ›` with value, source, close date and a template.
 */
export function CreateDealDialog({
  registry,
  presetCompany,
  triggerLabel = 'New deal',
  trigger,
  hotkey,
}: {
  registry: Array<RegistryEntry>
  /** Opened from a company: the deal is that company's, and no picker shows. */
  presetCompany?: { id: string; name: string }
  triggerLabel?: string
  /** A trigger of the caller's own — must forward props (plain DOM elements do). */
  trigger?: React.ReactNode
  /** Bare key that opens it from the page — in the default trigger's tooltip. */
  hotkey?: string
}) {
  const router = useRouter()
  const { today } = useClock()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [more, setMore] = useState(false)
  // Null while the name follows the company and the stage.
  const [typedName, setTypedName] = useState<string | null>(null)
  const [companyId, setCompanyId] = useState<string | null>(
    presetCompany?.id ?? null,
  )
  const [companyName, setCompanyName] = useState(presetCompany?.name ?? '')
  const companyDef = registry.find((d) => d.slug === 'company')
  const stageDef = registry.find((d) => d.slug === 'stage')
  // Born on the first live stage: a retired Pre-lead would be rejected.
  const firstStage = () =>
    (stageDef ? liveOptions(stageDef).at(0)?.id : undefined) ?? 'pre_lead'
  const [stage, setStage] = useState<string>(firstStage)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const moreDefs = registry.filter((d) => MORE_SLUGS.includes(d.slug))
  const composed = composeDealName(
    companyName,
    stageDef ? optionLabel(stageDef, stage) : '',
  )
  const name = typedName ?? composed

  // The picker answers an id; the name the deal is called by is read once.
  useEffect(() => {
    if (companyId === null || companyId === presetCompany?.id) return
    let alive = true
    getCompany({ data: { id: companyId } }).then(
      (c) => {
        if (alive) setCompanyName(c.name)
      },
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [companyId, presetCompany?.id])

  function reset() {
    setMore(false)
    setTypedName(null)
    setValues({})
    setStage(firstStage())
    setError(null)
    if (!presetCompany) {
      setCompanyId(null)
      setCompanyName('')
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!companyId) return setError('Pick the company.')
    const dealName = name.trim() || `${companyName || 'New'} deal`
    setPending(true)
    try {
      const { id } = await createDeal({
        data: {
          companyId,
          name: dealName,
          stage,
          value: typeof values.value === 'number' ? values.value : undefined,
          source: typeof values.source === 'string' ? values.source : undefined,
        },
      })
      if (values.close_date != null) {
        await updateRecord({
          data: { id, patch: { close_date: values.close_date } },
        })
      }
      setOpen(false)
      reset()
      toast(`${dealName} created`)
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the deal')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" shortcut={hotkey?.toUpperCase()}>
            <Plus className="size-4" strokeWidth={2} />
            {triggerLabel}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        size="m"
        className="max-h-[85vh] overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          noValidate
        >
          {companyDef && !presetCompany ? (
            <div className="space-y-1.5">
              <Label>Company</Label>
              <ValueEditor
                def={companyDef}
                value={companyId}
                variant="field"
                refNames={
                  companyId ? { [companyId]: { name: companyName } } : {}
                }
                onSave={(v) => {
                  const next = typeof v === 'string' ? v : null
                  setCompanyId(next)
                  if (next === null) setCompanyName('')
                }}
              />
            </div>
          ) : null}
          {stageDef ? (
            <div className="space-y-1.5">
              <Label>Stage</Label>
              <ValueEditor
                def={stageDef}
                value={stage}
                variant="field"
                onSave={(v) => setStage(String(v ?? firstStage()))}
              />
            </div>
          ) : null}

          <MoreFields
            open={more}
            onOpen={() => {
              setMore(true)
              setValues((s) => withTodayDates(moreDefs, s, today))
            }}
          >
            {/* Pre-fills the fields below, visibly and editably — never writes. */}
            <div className="flex justify-end sm:col-span-2">
              <TemplatePicker
                kind="record"
                objectKind="deal"
                context="deal"
                onPick={(t) => {
                  const tv = jsonRecord(jsonRecord(t.body).values)
                  if (typeof tv.stage === 'string') setStage(tv.stage)
                  setValues((s) => ({ ...tv, ...filledValues(s) }))
                }}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="deal-name">Name</Label>
              <Input
                id="deal-name"
                value={name}
                onChange={(e) =>
                  setTypedName(e.target.value === '' ? null : e.target.value)
                }
                placeholder="Pixxel — Series B"
              />
            </div>
            {moreDefs.map((def) => (
              <RegistryField
                key={def.slug}
                def={def}
                value={values[def.slug]}
                onChange={(v) => setValues((s) => ({ ...s, [def.slug]: v }))}
              />
            ))}
          </MoreFields>

          {error ? (
            <p role="alert" className="text-ui text-destructive sm:col-span-2">
              {error}
            </p>
          ) : null}

          <DialogFooter className="sm:col-span-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create deal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
