import {
  createFileRoute,
  getRouteApi,
  Link,
  useRouter,
} from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ObjectDialog } from '#/components/objects/object-dialog'
import {
  SettingsGroupHead,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { updateObject } from '#/lib/server-fns'
import type { listObjects } from '#/lib/server-fns'
import { objectIcon } from '#/lib/object-icons'
import { cn } from '#/lib/utils'

const shell = getRouteApi('/_app/settings')

/**
 * The object registry index. Each row links to that object's attributes
 * page, which sits in the same shell with this row still lit.
 */
export const Route = createFileRoute('/_app/settings/objects')({
  component: ObjectsRoute,
})

function ObjectsRoute() {
  const data = shell.useLoaderData()
  return <ObjectsSection objects={data.objects} isAdmin={data.isAdmin} />
}

type ObjectRow = Awaited<ReturnType<typeof listObjects>>[number]

/**
 * The object index in three groups: Built in (the system objects), Yours
 * (the custom ones) and Archived, each object restorable from there. A live
 * row links to its attributes page.
 */
function ObjectsSection({
  objects,
  isAdmin,
}: {
  objects: Array<ObjectRow>
  isAdmin: boolean
}) {
  const router = useRouter()
  const [restoring, setRestoring] = useState<string | null>(null)
  const builtIn = objects.filter((o) => o.isSystem && !o.archived)
  const yours = objects.filter((o) => !o.isSystem && !o.archived)
  const archived = objects.filter((o) => o.archived)

  async function restore(o: ObjectRow) {
    setRestoring(o.id)
    try {
      await updateObject({ data: { id: o.id, archived: false } })
      toast(`${o.plural} restored`)
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not restore')
    } finally {
      setRestoring(null)
    }
  }

  return (
    <SettingsSection
      title="Objects"
      crumb="Workspace"
      action={
        isAdmin ? (
          <ObjectDialog
            mode="create"
            onSaved={() => router.invalidate()}
            trigger={
              <Button size="sm" variant="outline">
                <Plus className="size-3" strokeWidth={2} />
                New object
              </Button>
            }
          />
        ) : null
      }
    >
      <SettingsGroupHead title="Built in" count={String(builtIn.length)} />
      <ObjectList objects={builtIn} label="Built-in objects" />

      <SettingsGroupHead title="Yours" count={String(yours.length)} />
      {yours.length === 0 ? (
        <p className="border-b border-rule py-3 text-label text-graphite">
          No objects of your own.
        </p>
      ) : (
        <ObjectList objects={yours} label="Your objects" />
      )}

      {archived.length > 0 ? (
        <>
          <SettingsGroupHead title="Archived" count={String(archived.length)} />
          <ul aria-label="Archived objects" className="flex flex-col">
            {archived.map((o) => (
              <li
                key={o.id}
                className="flex h-11 items-center gap-3 border-b border-rule text-graphite"
              >
                <ObjectMark object={o} muted />
                <span className="min-w-0 flex-1 truncate text-ui line-through">
                  {o.plural}
                </span>
                {isAdmin ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restoring !== null}
                    onClick={() => void restore(o)}
                  >
                    Restore
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </SettingsSection>
  )
}

/** An object's mark: its icon in a 22px frame, ink live, rule when archived. */
function ObjectMark({
  object,
  muted = false,
}: {
  object: ObjectRow
  muted?: boolean
}) {
  const Icon = objectIcon(object)
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-[1.375rem] shrink-0 items-center justify-center border bg-paper',
        muted ? 'border-rule' : 'border-hairline',
      )}
    >
      <Icon
        className={cn('size-3', muted ? 'text-graphite' : 'text-foreground')}
        strokeWidth={1.75}
      />
    </span>
  )
}

function ObjectList({
  objects,
  label,
}: {
  objects: Array<ObjectRow>
  label: string
}) {
  return (
    <ul aria-label={label} className="flex flex-col">
      {objects.map((o) => (
        <li key={o.id}>
          <Link
            to="/settings/objects/$objectSlug"
            params={{ objectSlug: o.slug }}
            className="focus-ring-inset flex h-11 items-center gap-3 border-b border-rule transition-colors duration-150 ease-out-quart hover:bg-bone"
          >
            <ObjectMark object={o} />
            <span className="min-w-0 flex-1 truncate text-ui font-medium">
              {o.plural}
            </span>
            <span className="shrink-0 mono text-micro text-graphite">
              {o.attributeCount} attribute{o.attributeCount === 1 ? '' : 's'}
            </span>
            <ChevronRight
              className="size-3.5 shrink-0 text-graphite"
              strokeWidth={1.75}
            />
          </Link>
        </li>
      ))}
    </ul>
  )
}
