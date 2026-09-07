import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Plus } from 'lucide-react'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import { RegistryList } from '#/components/attributes/registry-list'
import { Button } from '#/components/ui/button'
import { getObject, getSession, listRegistry } from '#/lib/server-fns'

/**
 * One object's attributes (spec §7, §9): the registry as a settings page,
 * keyed on the object row so companies, people, deals, and every custom
 * object get the same surface. This page is most of a custom object's
 * admin UI — creation lands here.
 */
export const Route = createFileRoute('/_app/settings_/objects/$objectSlug')({
  loader: async ({ params }) => {
    const [session, object] = await Promise.all([
      getSession(),
      getObject({ data: { slug: params.objectSlug } }),
    ])
    const registry = await listRegistry({
      data: { objectId: object.id, includeArchived: true },
    })
    return { object, registry, isAdmin: session?.user.role === 'admin' }
  },
  component: ObjectAttributesPage,
})

function ObjectAttributesPage() {
  const { object, registry, isAdmin } = Route.useLoaderData()
  const router = useRouter()
  const live = registry.filter((a) => !a.archived).length

  return (
    <div className="mx-auto w-full max-w-column px-6 py-8 md:px-10">
      <Link
        to="/settings"
        className="flex w-fit items-center gap-1.5 rounded-md text-ui text-muted-foreground focus-ring hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        Settings
      </Link>

      <header className="mt-5 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-page font-semibold tracking-tight">
            {object.plural}
          </h1>
          <p className="mt-1 text-ui text-muted-foreground">
            {live} attribute{live === 1 ? '' : 's'} on every{' '}
            {object.singular.toLowerCase()}. Rename anything, edit options, drag
            to reorder, archive what you don't use — types are fixed.
            {isAdmin ? '' : ' Reshaping is admin-only.'}
          </p>
        </div>
        <AttributeDialog
          mode="create"
          objectId={object.id}
          objectLabel={object.singular}
          onSaved={() => router.invalidate()}
          trigger={
            <Button size="sm">
              <Plus className="size-4" strokeWidth={2} />
              New attribute
            </Button>
          }
        />
      </header>

      <div className="mt-6">
        <RegistryList
          object={object}
          registry={registry}
          canReshape={isAdmin}
        />
      </div>
    </div>
  )
}
