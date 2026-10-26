import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select } from '#/components/ui/select'
import { createRelationship } from '#/lib/server-fns'
import type { Cardinality } from '@spaces/core/attributes/relationship'

/**
 * The Relationship dialog: two objects, the attribute's name on
 * each, and the cardinality — one commit that creates both halves. Object A
 * starts as the object the dialog was opened from.
 */

type ObjectChoice = { id: string; singular: string; plural: string }

const cardinalityWords = (
  card: Cardinality,
  a: ObjectChoice | undefined,
  b: ObjectChoice | undefined,
): string => {
  const one = (o: ObjectChoice | undefined) => o?.singular.toLowerCase() ?? '…'
  const many = (o: ObjectChoice | undefined) => o?.plural.toLowerCase() ?? '…'
  const [left, right] = card.split(':')
  return `${card} · ${left === '1' ? `one ${one(a)}` : `many ${many(a)}`} to ${right === '1' ? `one ${one(b)}` : `many ${many(b)}`}`
}

const CARDS: ReadonlyArray<Cardinality> = ['N:N', 'N:1', '1:N', '1:1']

export function RelationshipDialog({
  objectId,
  objects,
  open,
  onOpenChange,
  onCreated,
}: {
  /** The object the dialog was opened from — object A to begin with. */
  objectId: string
  /** Every live object a relationship may join. */
  objects: ReadonlyArray<ObjectChoice>
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="m" aria-describedby={undefined}>
        {open ? (
          <RelationshipForm
            objectId={objectId}
            objects={objects}
            onDone={(created) => {
              onOpenChange(false)
              if (created) onCreated()
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function RelationshipForm({
  objectId,
  objects,
  onDone,
}: {
  objectId: string
  objects: ReadonlyArray<ObjectChoice>
  onDone: (created: boolean) => void
}) {
  const [a, setA] = useState(objectId)
  const [b, setB] = useState(
    objects.find((o) => o.id !== objectId)?.id ?? objectId,
  )
  const [nameA, setNameA] = useState('')
  const [nameB, setNameB] = useState('')
  const [card, setCard] = useState<Cardinality>('N:N')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const objectA = objects.find((o) => o.id === a)
  const objectB = objects.find((o) => o.id === b)
  const items = objects.map((o) => ({ value: o.id, label: o.plural }))

  async function submit() {
    if (pending) return
    if (!nameA.trim() || !nameB.trim()) {
      setError('Name both sides')
      return
    }
    setPending(true)
    setError(null)
    try {
      await createRelationship({
        data: {
          objectId: a,
          name: nameA.trim(),
          targetObjectId: b,
          inverseName: nameB.trim(),
          cardinality: card,
        },
      })
      toast(`${nameA.trim()} ↔ ${nameB.trim()} created`)
      onDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create')
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          void submit()
        }
      }}
      className="space-y-5"
    >
      <DialogHeader>
        <DialogTitle>New relationship</DialogTitle>
        <DialogDescription>
          {objectA?.plural ?? '…'} ↔ {objectB?.plural ?? '…'}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rel-object-a">Object A</Label>
          <Select
            id="rel-object-a"
            value={a}
            onChange={setA}
            items={items}
            width="trigger"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rel-name-a">Name on {objectA?.plural ?? 'A'}</Label>
          <Input
            id="rel-name-a"
            value={nameA}
            spellCheck={false}
            autoComplete="off"
            placeholder={objectB?.plural ?? ''}
            onChange={(e) => setNameA(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rel-object-b">Object B</Label>
          <Select
            id="rel-object-b"
            value={b}
            onChange={setB}
            items={items}
            width="trigger"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rel-name-b">Name on {objectB?.plural ?? 'B'}</Label>
          <Input
            id="rel-name-b"
            value={nameB}
            spellCheck={false}
            autoComplete="off"
            placeholder={objectA?.plural ?? ''}
            onChange={(e) => setNameB(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rel-cardinality">Cardinality</Label>
        <Select
          id="rel-cardinality"
          value={card}
          onChange={setCard}
          items={CARDS.map((c) => ({
            value: c,
            label: cardinalityWords(c, objectA, objectB),
          }))}
          width="trigger"
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="flex items-center gap-2 text-ui text-destructive"
        >
          <span aria-hidden className="size-2 shrink-0 bg-destructive" />
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" pending={pending}>
          {pending ? 'Creating…' : 'Create relationship'}
        </Button>
      </DialogFooter>
    </form>
  )
}
