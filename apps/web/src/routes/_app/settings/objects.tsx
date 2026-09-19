import {
  createFileRoute,
  getRouteApi,
  Link,
  useRouter,
} from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { ObjectDialog } from '#/components/objects/object-dialog'
import { SettingsSection } from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { updateObject } from '#/lib/server-fns'
import type { listObjects } from '#/lib/server-fns'
import { objectIcon } from '#/lib/object-icons'

const shell = getRouteApi('/_app/settings')

/**
 * The object registry index. One object's attributes page
 * (`/settings/objects/$objectSlug`) deliberately escapes this shell — it is
 * a record page for one object, not a settings section — and comes back
 * here by its crumb.
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
 * The object index: one row per object (system rows first), each linking to
 * its attributes page. Custom objects join this list when SPA-13 lands —
 * the page they get is the same one.
 */
function ObjectsSection({
  objects,
  isAdmin,
}: {
  objects: Array<ObjectRow>
  isAdmin: boolean
}) {
  const router = useRouter()
  const live = objects.filter((o) => !o.archived)
  const archived = objects.filter((o) => o.archived)
  return (
    <SettingsSection
      title="Objects"
      blurb="The records you keep and the attributes on each. Open one to rename, reorder, archive, or add attributes — types are fixed."
      crumb="Objects"
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
      <ul className="flex flex-col">
        {live.map((o) => {
          const Icon = objectIcon(o)
          return (
            <li key={o.id}>
              <Link
                to="/settings/objects/$objectSlug"
                params={{ objectSlug: o.slug }}
                className="focus-ring-inset flex h-12 items-center gap-3 border-b border-rule transition-colors duration-150 ease-out-quart hover:bg-bone"
              >
                <span className="flex size-[1.375rem] shrink-0 items-center justify-center border border-hairline bg-paper">
                  <Icon className="size-3 text-foreground" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium">
                    {o.plural}
                  </span>
                  <span className="block mono text-micro text-graphite">
                    {o.attributeCount} attribute
                    {o.attributeCount === 1 ? '' : 's'}
                    {' · '}
                    {o.isSystem ? 'system' : 'custom'}
                  </span>
                </span>
                <ChevronRight
                  className="size-3.5 shrink-0 text-graphite"
                  strokeWidth={1.75}
                />
              </Link>
            </li>
          )
        })}
      </ul>
      {archived.length > 0 ? (
        <ul className="flex flex-col text-graphite">
          {archived.map((o) => {
            const Icon = objectIcon(o)
            return (
              <li
                key={o.id}
                className="flex h-12 items-center gap-3 border-b border-dashed border-rule"
              >
                <span className="flex size-[1.375rem] shrink-0 items-center justify-center border border-rule bg-paper">
                  <Icon className="size-3" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium line-through">
                    {o.plural}
                  </span>
                  <span className="block mono text-micro">
                    archived — records kept, routes and pickers hidden
                  </span>
                </span>
                {isAdmin ? (
                  <button
                    type="button"
                    className="focus-ring mono text-micro hover:text-foreground"
                    onClick={async () => {
                      await updateObject({
                        data: { id: o.id, archived: false },
                      })
                      toast(`${o.plural} restored`)
                      void router.invalidate()
                    }}
                  >
                    restore
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </SettingsSection>
  )
}
