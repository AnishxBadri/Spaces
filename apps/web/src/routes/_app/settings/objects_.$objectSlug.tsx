import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import { AiConfigSection } from '#/components/attributes/ai-config-section'
import { ObjectDialog } from '#/components/objects/object-dialog'
import { RegistryList } from '#/components/attributes/registry-list'
import { KeyHint } from '#/components/page-header'
import { SettingsSection } from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import {
  IDENTITY_KEYS,
  IDENTITY_KEY_ATTRIBUTES,
} from '@spaces/core/attributes/registry'
import { getObject, listRegistry, updateObject } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import type { IdentityKey } from '@spaces/core/attributes/registry'

const shell = getRouteApi('/_app/settings')

/**
 * One object's attributes (spec §7, §9): the registry as a settings page,
 * keyed on the object row so companies, people, deals, and every custom
 * object get the same surface. This page is most of a custom object's
 * admin UI — creation lands here.
 * - Inside the settings shell, so the nav stays and Objects stays lit.
 * - The escaping `_` keeps it out of the object index's component.
 */
export const Route = createFileRoute('/_app/settings/objects_/$objectSlug')({
  loader: async ({ params }) => {
    const object = await getObject({ data: { slug: params.objectSlug } })
    const registry = await listRegistry({
      data: { objectId: object.id, includeArchived: true },
    })
    return { object, registry }
  },
  component: ObjectAttributesPage,
})

function ObjectAttributesPage() {
  const { object, registry } = Route.useLoaderData()
  const { isAdmin } = shell.useLoaderData()
  const router = useRouter()
  const live = registry.filter((a) => !a.archived).length
  const archivedCount = registry.length - live
  const [creating, setCreating] = useState(false)
  useHotkey('a', () => setCreating(true))

  // The identity-key declaration is live while the object is empty and read
  // only once a record exists (§9 — the slug rule). Each tick is a save:
  // ticking materializes the backing attribute, unticking deletes it, which
  // is why the registry above is re-read after every one.
  const [saving, setSaving] = useState<IdentityKey | null>(null)
  const editable = isAdmin && !object.isSystem && !object.hasRecords
  async function toggleKey(key: IdentityKey, next: boolean) {
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

  const blurb = [
    `${live} attribute${live === 1 ? '' : 's'} on every ${object.singular.toLowerCase()}`,
    ...(archivedCount > 0 ? [`${archivedCount} archived`] : []),
    ...(isAdmin ? [] : ['reshaping is admin-only']),
  ].join(' · ')

  return (
    <SettingsSection
      title={object.plural}
      blurb={blurb}
      crumb="Objects"
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
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3" strokeWidth={2} />
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
    >
      {object.archived ? (
        <p className="mt-6 border border-dashed border-rule px-3 py-2 text-ui text-graphite">
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

      {/* AI attributes (SPA-72): config on the existing types — the
            spec's `attribute.config.ai`, stored as `options.ai`. Offered
            only on types that can hold a mode; core and custom objects
            alike. */}
      <AiConfigSection
        objectPlural={object.plural}
        registry={registry}
        canReshape={isAdmin}
      />

      {/* Identity keys (spec §9) — each backed by an attribute above, and
            revisable only while the object has no records (the slug rule).
            Core objects are not listed: their identity is core-owned and
            lives in entity_alias, not in this column. */}
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
          {editable ? (
            <ul aria-label={`${object.plural} identity keys`}>
              {IDENTITY_KEYS.map((key) => {
                const backing = IDENTITY_KEY_ATTRIBUTES[key]
                const on = object.identityKeys.includes(key)
                return (
                  <li key={key}>
                    <label className="flex h-row cursor-pointer items-center gap-3 border-b border-rule text-ui">
                      <Checkbox
                        checked={on}
                        disabled={saving !== null}
                        aria-label={backing.name}
                        onCheckedChange={(next) => void toggleKey(key, next)}
                      />
                      <span className="min-w-0 flex-1">{backing.name}</span>
                      <span className="mono text-micro text-graphite">
                        {backing.slug} · {backing.type}
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
          )}
          {object.hasRecords ? (
            <p className="flex h-row items-center text-ui text-graphite">
              Frozen: {object.plural} has records, and a key that justified a
              record&apos;s identity cannot be withdrawn under it.
            </p>
          ) : (
            <p className="flex h-8 items-center mono text-micro text-graphite">
              revisable while empty · ticking one creates its attribute,
              unticking one deletes it
            </p>
          )}
        </section>
      )}
    </SettingsSection>
  )
}
