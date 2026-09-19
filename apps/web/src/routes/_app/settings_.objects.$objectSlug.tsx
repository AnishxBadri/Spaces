import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import { ObjectDialog } from '#/components/objects/object-dialog'
import { RegistryList } from '#/components/attributes/registry-list'
import { KeyHint, PageHeader } from '#/components/page-header'
import { Button } from '#/components/ui/button'
import { IDENTITY_KEY_ATTRIBUTES } from '@spaces/core/attributes/registry'
import {
  getObject,
  getSession,
  listRegistry,
  updateObject,
} from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'

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
  const archivedCount = registry.length - live
  const [creating, setCreating] = useState(false)
  useHotkey('a', () => setCreating(true))

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <Link to="/settings" className="focus-ring hover:text-foreground">
              Settings
            </Link>
            <span className="text-rule">/</span>
            <Link
              to="/settings/objects"
              className="focus-ring hover:text-foreground"
            >
              Objects
            </Link>
          </span>
        }
        title={object.plural}
        description={
          <>
            <span>
              {live} attribute{live === 1 ? '' : 's'} on every{' '}
              {object.singular.toLowerCase()}
            </span>
            <span>types are fixed · rename, reorder, archive</span>
            {archivedCount > 0 ? <span>{archivedCount} archived</span> : null}
            {isAdmin ? null : <span>reshaping is admin-only</span>}
          </>
        }
        action={
          <>
            {!object.isSystem && isAdmin ? (
              <>
                <ObjectDialog
                  mode="edit"
                  object={object}
                  onSaved={() => router.invalidate()}
                  trigger={
                    <Button size="sm" variant="outline">
                      <Pencil className="size-3.5" strokeWidth={1.75} />
                      Edit
                    </Button>
                  }
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await updateObject({
                        data: { id: object.id, archived: !object.archived },
                      })
                      toast(
                        object.archived
                          ? `${object.plural} restored`
                          : `${object.plural} archived — records kept`,
                      )
                      void router.invalidate()
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : 'Could not update',
                      )
                    }
                  }}
                >
                  {object.archived ? (
                    <ArchiveRestore className="size-3.5" strokeWidth={1.75} />
                  ) : (
                    <Archive className="size-3.5" strokeWidth={1.75} />
                  )}
                  {object.archived ? 'Restore' : 'Archive'}
                </Button>
              </>
            ) : null}
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" strokeWidth={2} />
              New attribute
              <KeyHint>A</KeyHint>
            </Button>
            <AttributeDialog
              mode="create"
              objectId={object.id}
              objectLabel={object.singular}
              objectPlural={object.plural}
              attributeCount={live}
              open={creating}
              onOpenChange={setCreating}
              onSaved={() => router.invalidate()}
            />
          </>
        }
      />
      <div className="max-w-220 px-8 pt-6 pb-8">
        {object.archived ? (
          <p className="border border-dashed border-rule px-3 py-2 text-ui text-graphite">
            Archived: the list and record pages are hidden and pickers skip it.
            Records and their values are kept; Restore brings everything back.
          </p>
        ) : null}

        <div className="mt-6">
          <RegistryList
            object={object}
            registry={registry}
            canReshape={isAdmin}
          />
        </div>

        {/* Identity keys (spec §9) — declared at creation, each backed by the
            attribute above it. Core objects are not listed: their identity is
            core-owned and lives in entity_alias, not in this column. */}
        {object.isSystem ? null : (
          <section className="mt-8 flex flex-col">
            <div
              aria-hidden
              className="flex h-8 items-center gap-3 border-b border-hairline label-caps text-graphite"
            >
              <span className="min-w-0 flex-1">Identity keys</span>
              <span className="mono text-micro">
                {object.identityKeys.length} declared
              </span>
            </div>
            <ul aria-label={`${object.plural} identity keys`}>
              {object.identityKeys.map((key) => {
                const backing = IDENTITY_KEY_ATTRIBUTES[key]
                return (
                  <li
                    key={key}
                    className="flex h-row items-center gap-3 border-b border-rule text-ui"
                  >
                    <span className="min-w-0 flex-1">{backing.name}</span>
                    <span className="mono text-micro text-graphite">
                      {backing.slug} · {backing.type}
                    </span>
                  </li>
                )
              })}
              {object.identityKeys.length === 0 ? (
                <li className="flex h-row items-center border-b border-rule text-ui text-graphite">
                  None — records here are matched by name alone.
                </li>
              ) : null}
            </ul>
            <p className="flex h-8 items-center mono text-micro text-graphite">
              declared at creation · the backing attribute cannot be archived
              while its key stands
            </p>
          </section>
        )}
      </div>
    </div>
  )
}
