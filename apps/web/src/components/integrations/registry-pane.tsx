import { useRef } from 'react'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import type { AvailablePlugin, RegistryView } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

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

/**
 * In the registry: every plugin the image's signed registry offers that this
 * box has not installed — name, what it does, what it will ask for, Install.
 * One 40px row per plugin, lanes beside the Installed ledger's. A removed
 * plugin is back here, and installing it again reuses its old row.
 */
export function RegistryPane({
  view,
  pending,
  onInstall,
}: {
  view: RegistryView
  /** The plugin whose install is in flight; every Install waits on it. */
  pending: string | null
  onInstall: (plugin: AvailablePlugin) => void
}) {
  const { available } = view
  return (
    <div className="flex flex-col pt-8">
      <SectionHead
        as="h3"
        title="In the registry"
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
        <ol>
          {available.map((plugin, i) => (
            <li
              key={plugin.pluginId}
              className={cn(
                'flex h-ledger-row items-center gap-3 px-3',
                i !== available.length - 1 && 'border-b border-rule',
              )}
            >
              <span className="flex w-48 shrink-0 items-baseline gap-2">
                <span className="min-w-0 truncate text-body font-medium text-foreground">
                  {plugin.name}
                </span>
                <span className="shrink-0 mono text-micro text-graphite">
                  {plugin.version}
                </span>
              </span>
              <span
                className="min-w-0 flex-1 truncate text-ui text-graphite"
                title={plugin.description}
              >
                {plugin.description}
              </span>
              <span className="w-44 shrink-0 truncate mono text-micro text-graphite">
                {plugin.needs}
              </span>
              <span className="flex w-18 shrink-0 justify-end">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => onInstall(plugin)}
                >
                  {pending === plugin.pluginId ? 'Installing' : 'Install'}
                </Button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
