import { useRef, useState } from 'react'
import { SettingsGroupHead } from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Tabs } from '#/components/ui/tabs'
import { catalogueTabs, inTab, roleWords } from '#/lib/integrations/catalogue'
import type { CatalogueTab } from '#/lib/integrations/catalogue'
import type { AvailablePlugin, RegistryView } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { PluginMark } from './integration-ledger'

/**
 * Upload a plugin: the page head's second door to the same installer, for a
 * box with no outbound HTTPS. The operator picks the release's `.tgz` and
 * the `.json` entry published beside it, together; a refusal is the same
 * named reason a registry install gives.
 */
export function UploadPlugin({
  pending,
  disabled,
  onUpload,
}: {
  /** An upload is in flight. */
  pending: boolean
  /** Any install is in flight; the upload waits on it. */
  disabled: boolean
  onUpload: (files: ReadonlyArray<File>) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        title="Choose the .tgz and the .json entry its release published"
        onClick={() => input.current?.click()}
      >
        {pending ? 'Uploading' : 'Upload a plugin'}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept=".tgz,.json"
        aria-label="Plugin tarball and its entry"
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length > 0) onUpload(files)
        }}
      />
    </>
  )
}

/** The hash an `Install ›` elsewhere in settings lands on: this plugin's row. */
export const pluginAnchor = (pluginId: string): string => `plugin-${pluginId}`

/**
 * Available: every plugin the image's signed registry offers that this box
 * has not installed, in tabs by the job it does — All, each role some entry
 * names, and Other only when an entry names none. One row per plugin: mark,
 * name and version over what it does, its jobs and what it will ask for,
 * Install. A removed plugin is back here, and installing it again reuses its
 * old row. (D81)
 */
export function RegistryPane({
  view,
  pending,
  disabled = false,
  onInstall,
}: {
  view: RegistryView
  /** The plugin whose install is in flight; every Install waits on it. */
  pending: string | null
  /** A member reads the catalogue; Install is the admin's. */
  disabled?: boolean
  onInstall: (plugin: AvailablePlugin) => void
}) {
  const { available } = view
  const tabs = catalogueTabs(available)
  const [chosen, setTab] = useState<CatalogueTab>('all')
  // A tab emptied by an install falls back to All.
  const tab = tabs.some((t) => t.id === chosen) ? chosen : 'all'
  const shown = available.filter((p) => inTab(p, tab))
  return (
    <div className="flex flex-col">
      <SettingsGroupHead
        title="Available"
        count={String(available.length)}
        action="signed by the project"
      />
      {view.error !== null ? (
        <p role="alert" className="px-3 py-3 mono text-micro text-destructive">
          {view.error}
        </p>
      ) : available.length === 0 ? (
        <p className="px-3 py-3 text-ui text-graphite">
          Nothing in the registry that is not installed.
        </p>
      ) : (
        <Tabs
          label="Available plugins by job"
          items={tabs}
          value={tab}
          onValueChange={setTab}
        >
          <ol>
            {shown.map((plugin, i) => (
              <li
                key={plugin.pluginId}
                id={pluginAnchor(plugin.pluginId)}
                data-plugin={plugin.pluginId}
                className={cn(
                  'flex min-h-ledger-row scroll-mt-6 items-center gap-3 px-3 py-1.5',
                  i !== shown.length - 1 && 'border-b border-rule',
                )}
              >
                <PluginMark name={plugin.name} offered />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-body font-medium text-foreground">
                      {plugin.name}
                    </span>
                    <span className="shrink-0 mono text-micro text-graphite">
                      v{plugin.version}
                    </span>
                  </span>
                  <span
                    className="truncate text-ui text-graphite"
                    title={plugin.description}
                  >
                    {plugin.description}
                  </span>
                </span>
                <span className="w-40 shrink-0 truncate mono text-micro text-graphite">
                  {plugin.roles.length > 0 ? roleWords(plugin.roles) : 'Other'}
                </span>
                <span className="w-32 shrink-0 truncate mono text-micro text-graphite">
                  {plugin.needs}
                </span>
                <span className="flex w-18 shrink-0 justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled || pending !== null}
                    onClick={() => onInstall(plugin)}
                  >
                    {pending === plugin.pluginId ? 'Installing' : 'Install'}
                  </Button>
                </span>
              </li>
            ))}
          </ol>
        </Tabs>
      )}
    </div>
  )
}
