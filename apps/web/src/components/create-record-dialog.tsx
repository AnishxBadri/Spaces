import { useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import {
  filledValues,
  IdentityRefusal,
  MoreFields,
  RegistryField,
  useIdentityCheck,
  withTodayDates,
} from '#/components/create-window'
import { useClock } from '#/components/clock'
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
import { collisionToast } from '#/lib/attributes/collision-toast'
import { createObjectRecord } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'

/** The typed keys of one identity value: a single key or a list of them. */
function keysOf(value: unknown): Array<string> {
  const all = Array.isArray(value) ? value : [value]
  return all.filter((v): v is string => typeof v === 'string' && v !== '')
}

/**
 * The New window of a custom object: the name and the object's identity
 * keys; its other fields wait behind `More fields ›`. A key another record
 * already holds is refused here, with the way to that record.
 */
export function CreateRecordDialog({
  object,
  registry,
  refNames,
  hotkey,
  trigger,
}: {
  object: { id: string; singular: string; plural: string }
  registry: Array<RegistryEntry>
  refNames: Record<string, { name: string }>
  /** Bare key that opens it from the page — in the trigger's tooltip. */
  hotkey?: string
  /** The control that opens it; the head's New button by default. */
  trigger?: ReactNode
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { today } = useClock()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [more, setMore] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const identity = useIdentityCheck('domain')
  const singular = object.singular.toLowerCase()
  const identityDefs = registry.filter(
    (def) => def.options?.identityKey !== undefined,
  )
  const moreDefs = registry.filter(
    (def) => def.options?.identityKey === undefined,
  )

  function reset() {
    setName('')
    setMore(false)
    setValues({})
    setError(null)
    identity.clear()
  }

  /** Every identity value asked after in turn; the first one held stops it. */
  async function checkIdentity(
    next: Record<string, unknown>,
  ): Promise<boolean> {
    identity.clear()
    for (const def of identityDefs) {
      const key = def.options?.identityKey
      if (key === undefined) continue
      for (const typed of keysOf(next[def.slug]))
        if ((await identity.check(typed, key))?.owner) return true
    }
    return false
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) return setError(`Name the ${singular}.`)
    setPending(true)
    try {
      if (await checkIdentity(values)) return
      const result = await createObjectRecord({
        data: {
          objectId: object.id,
          name: name.trim(),
          values: filledValues(values),
        },
      })
      setOpen(false)
      reset()
      // A key claimed by another writer between the check and the create
      // is the same collision an edit makes; its toast says so.
      const collision = collisionToast(result, object.singular)
      if (collision)
        toast(collision.title, { description: collision.description })
      else toast(`${name.trim()} added`)
      void router.invalidate()
      // The rows come from a keyed query, not from the loader alone.
      void queryClient.invalidateQueries({ queryKey: ['object-records'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it.')
    } finally {
      setPending(false)
    }
  }

  const field = (
    def: RegistryEntry,
    onSaved?: (next: Record<string, unknown>) => void,
  ) => (
    <RegistryField
      key={def.slug}
      def={def}
      value={values[def.slug]}
      refNames={refNames}
      onChange={(v) => {
        const next = { ...values, [def.slug]: v }
        setValues(next)
        onSaved?.(next)
      }}
    />
  )

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
          <Button shortcut={hotkey?.toUpperCase()}>New {singular}</Button>
        )}
      </DialogTrigger>
      <DialogContent
        size="m"
        className="max-h-[85vh] overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>New {singular}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          noValidate
        >
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="record-name">Name</Label>
            <Input
              id="record-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {identityDefs.map((def) =>
            field(def, (next) => void checkIdentity(next)),
          )}
          {identity.owner ? (
            <IdentityRefusal
              owner={identity.owner}
              identityKey={identity.key}
              className="sm:col-span-2"
            />
          ) : null}

          {moreDefs.length > 0 ? (
            <MoreFields
              open={more}
              onOpen={() => {
                setMore(true)
                setValues((s) => withTodayDates(moreDefs, s, today))
              }}
            >
              {moreDefs.map((def) => field(def))}
            </MoreFields>
          ) : null}

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
            <Button type="submit" disabled={pending || identity.owner !== null}>
              {pending ? 'Adding…' : `Create ${singular}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
