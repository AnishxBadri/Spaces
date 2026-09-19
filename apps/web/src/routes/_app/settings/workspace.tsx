import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { saveWorkspace } from '#/lib/server-fns'

const shell = getRouteApi('/_app/settings')

/** The workspace singleton — the deployment's name. */
export const Route = createFileRoute('/_app/settings/workspace')({
  component: WorkspaceRoute,
})

function WorkspaceRoute() {
  const data = shell.useLoaderData()
  return (
    <WorkspaceSection
      name={data.workspace?.name ?? ''}
      isAdmin={data.isAdmin}
    />
  )
}

function WorkspaceSection({
  name,
  isAdmin,
}: {
  name: string
  isAdmin: boolean
}) {
  const router = useRouter()
  const [value, setValue] = useState(name)
  const [pending, setPending] = useState(false)
  const dirty = value.trim() !== name && value.trim().length > 0

  async function save() {
    setPending(true)
    try {
      await saveWorkspace({ data: { name: value.trim() } })
      toast.success('Workspace renamed')
      void router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not rename')
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsSection
      title="Workspace"
      blurb="The deployment's name. It sits in the chassis next to the mark."
      crumb="Workspace"
    >
      <SettingsRow
        label="Name"
        hint={
          isAdmin
            ? 'Shown to every member.'
            : 'Only admins can rename the workspace.'
        }
      >
        <Input
          id="ws-name"
          aria-label="Workspace name"
          value={value}
          disabled={!isAdmin}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your fund's name"
          className="w-56"
        />
        {isAdmin ? (
          <Button size="sm" disabled={!dirty || pending} onClick={save}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  )
}
