import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import { AiConfigSection } from '#/components/attributes/ai-config-section'
import { RelationshipDialog } from '#/components/attributes/relationship-dialog'
import { ObjectDialog } from '#/components/objects/object-dialog'
import {
  RegistryList,
  TYPE_LABELS,
} from '#/components/attributes/registry-list'
import {
  SettingsGroupHead,
  SettingsSection,
} from '#/components/settings/settings-section'
import { ListMenu } from '#/components/table/list-menu'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import {
  IDENTITY_KEYS,
  IDENTITY_KEY_ATTRIBUTES,
} from '@spaces/core/attributes/registry'
import {
  getEnrichmentPage,
  getObject,
  listRegistry,
  updateObject,
} from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import type { IdentityKey } from '@spaces/core/attributes/registry'

const shell = getRouteApi('/_app/settings')

/**
 * One object's attributes: the registry as a settings page,
 * keyed on the object row so companies, people, deals, and every custom
 * object get the same surface. This page is most of a custom object's
 * admin UI — creation lands here.
 * - Inside the settings shell, so the nav stays and Objects stays lit.
 * - The escaping `_` keeps it out of the object index's component.
 */
export const Route = createFileRoute('/_app/settings/objects_/$objectSlug')({
  loader: async ({ params }) => {
    const object = await getObject({ data: { slug: params.objectSlug } })
    const [registry, filledBy] = await Promise.all([
      listRegistry({
        data: {
          objectId: object.id,
          includeArchived: true,
          includeDerived: true,
        },
      }),
      filledByOf(object),
    ])
    return { object, registry, filledBy }
  },
  component: ObjectAttributesPage,
})

/**
 * Attribute id → the enrichment source that fills it, from the Enrichment
 * page's grid. Only Companies and People fill from enrichment; a
 * failed read leaves the Rules lane without it rather than failing the page.
 */
async function filledByOf(object: {
  slug: string
  isSystem: boolean
}): Promise<Record<string, string>> {
  const kind = !object.isSystem
    ? null
    : object.slug === 'companies'
      ? 'company'
      : object.slug === 'people'
        ? 'person'
        : null
  if (kind === null) return {}
  try {
    const { grids } = await getEnrichmentPage()
    const rows = grids.find((g) => g.kind === kind)?.rows ?? []
    return Object.fromEntries(
      rows.flatMap((r) => (r.filledBy === null ? [] : [[r.id, r.filledBy]])),
    )
  } catch {
    return {}
  }
}

function ObjectAttributesPage() {
  const { object, registry, filledBy } = Route.useLoaderData()
  const { isAdmin, objects } = shell.useLoaderData()
  const router = useRouter()
  const live = registry.filter((a) => !a.archived).length
  const [creating, setCreating] = useState(false)
  const [relating, setRelating] = useState(false)
  const [editingObject, setEditingObject] = useState(false)
  const { confirm, confirmDialog } = useConfirm()
  useHotkey('a', () => setCreating(true))

  async function toggleArchived() {
    if (!object.archived) {
      const ok = await confirm({
        title: `Archive ${object.plural}?`,
        body: `The ${object.plural} list and record pages are hidden and pickers skip it. Records and their values are kept; Restore brings everything back.`,
        action: 'Archive',
      })
      if (!ok) return
    }
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
      toast.error(err instanceof Error ? err.message : 'Could not update')
    }
  }

  // The identity-key declaration is live while the object is empty and read
  // only once a record exists (the slug rule). Each tick is a save:
  // ticking materializes the backing attribute, unticking deletes it — which
  // is why an untick asks first, and the registry is re-read after every one.
  const [saving, setSaving] = useState<IdentityKey | null>(null)
  const editable = isAdmin && !object.isSystem && !object.hasRecords
  async function toggleKey(key: IdentityKey, next: boolean) {
    if (!next) {
      const backing = IDENTITY_KEY_ATTRIBUTES[key]
      const ok = await confirm({
        title: `Stop matching ${object.plural.toLowerCase()} on ${backing.name}?`,
        body: `The ${backing.name} attribute is deleted from ${object.plural}, and new ${object.plural.toLowerCase()} are no longer matched to existing ones by it.`,
        action: 'Untick',
      })
      if (!ok) return
    }
    setSaving(key)
    try {
      await updateObject({
        data: {
          id: object.id,
          identityKeys: next
            ? [...object.identityKeys, key]
            : object.identityKeys.filter((k) => k !== key),
        },
      })
      const name = IDENTITY_KEY_ATTRIBUTES[key].name
      toast(
        next
          ? `${name} is an identity key — its attribute is on every ${object.singular.toLowerCase()}`
          : `${name} is no longer an identity key — its attribute is gone`,
      )
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update')
    } finally {
      setSaving(null)
    }
  }

  return (
    <SettingsSection
      title={object.plural}
      crumb="Workspace"
      action={
        <>
          {object.archived ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRelating(true)}
            >
              New relationship
            </Button>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3" strokeWidth={2} />
                New attribute
              </Button>
            </TooltipTrigger>
            <TooltipContent>A</TooltipContent>
          </Tooltip>
          {!object.isSystem && isAdmin ? (
            <>
              <ListMenu
                label={object.plural}
                verbs={[
                  { label: 'Edit…', onSelect: () => setEditingObject(true) },
                  {
                    label: object.archived ? 'Restore' : 'Archive',
                    onSelect: () => void toggleArchived(),
                  },
                ]}
              />
              <ObjectDialog
                mode="edit"
                object={object}
                open={editingObject}
                onOpenChange={setEditingObject}
                onSaved={() => router.invalidate()}
              />
            </>
          ) : null}
          <RelationshipDialog
            objectId={object.id}
            objects={objects.filter((o) => !o.archived)}
            open={relating}
            onOpenChange={setRelating}
            onCreated={() => router.invalidate()}
          />
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
    >
      {object.archived ? (
        <p className="mt-6 border border-dashed border-rule px-3 py-2 text-ui text-graphite">
          Archived: the list and record pages are hidden and pickers skip it.
          Records and their values are kept; Restore brings everything back.
        </p>
      ) : null}

      <RegistryList
        object={object}
        registry={registry}
        canReshape={isAdmin}
        objectNames={new Map(objects.map((o) => [o.id, o.plural]))}
        filledBy={new Map(Object.entries(filledBy))}
      />

      <AiConfigSection
        objectPlural={object.plural}
        registry={registry}
        canReshape={isAdmin}
      />

      {/* Identity keys — each backed by an attribute above, and
            revisable only while the object has no records (the slug rule).
            Core objects are not listed: their identity is core-owned and
            lives in entity_alias, not in this column. */}
      {object.isSystem ? null : (
        <section className="flex flex-col">
          <SettingsGroupHead
            title="Identity keys"
            count={`${object.identityKeys.length} declared`}
          />
          {editable ? (
            <ul aria-label={`${object.plural} identity keys`}>
              {IDENTITY_KEYS.map((key) => {
                const backing = IDENTITY_KEY_ATTRIBUTES[key]
                const on = object.identityKeys.includes(key)
                return (
                  <li key={key}>
                    <label className="flex h-ledger-row cursor-pointer items-center gap-3 border-b border-rule px-3 text-body">
                      <Checkbox
                        checked={on}
                        disabled={saving !== null}
                        aria-label={backing.name}
                        onCheckedChange={(next) => void toggleKey(key, next)}
                      />
                      <span className="min-w-0 flex-1">{backing.name}</span>
                      <span className="mono text-micro text-graphite">
                        {TYPE_LABELS[backing.type] ?? backing.type}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          ) : (
            <ul aria-label={`${object.plural} identity keys`}>
              {object.identityKeys.map((key) => {
                const backing = IDENTITY_KEY_ATTRIBUTES[key]
                return (
                  <li
                    key={key}
                    className="flex h-ledger-row items-center gap-3 border-b border-rule px-3 text-body"
                  >
                    <span className="min-w-0 flex-1">{backing.name}</span>
                    <span className="mono text-micro text-graphite">
                      {TYPE_LABELS[backing.type] ?? backing.type}
                    </span>
                  </li>
                )
              })}
              {object.identityKeys.length === 0 ? (
                <li className="flex h-ledger-row items-center border-b border-rule px-3 text-ui text-graphite">
                  None — records here are matched by name alone.
                </li>
              ) : null}
            </ul>
          )}
          {object.hasRecords ? (
            <p className="flex h-ledger-row items-center px-3 text-ui text-graphite">
              Frozen: {object.plural} has records, and a key that justified a
              record&apos;s identity cannot be withdrawn under it.
            </p>
          ) : null}
        </section>
      )}
      {confirmDialog}
    </SettingsSection>
  )
}
