import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import {
  DropZone,
  ImportHeader,
  PreviousImportNotice,
  StepStrip,
  objectForSearch,
} from '#/components/import/import-wizard'
import { Button } from '#/components/ui/button'
import { uploadImport } from '#/lib/import/upload'
import { listObjects } from '#/lib/server-fns'
import type { PreviousImport } from '#/components/import/import-wizard'

/**
 * `/import` — the wizard before a file (SPA-164). Reached by URL, from the
 * `Import` action on an object list page (which carries `?object=<slug>` so
 * the target is picked already), never from the sidebar.
 */
const importSearch = z.object({
  object: z.string().max(80).optional(),
})

export const Route = createFileRoute('/_app/import')({
  validateSearch: importSearch,
  loader: async () => listObjects(),
  component: ImportPage,
})

function ImportPage() {
  const objects = Route.useLoaderData()
  const { object: slug } = Route.useSearch()
  const navigate = useNavigate()
  const target = objectForSearch(objects, slug)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<{
    file: File
    previous: PreviousImport
  } | null>(null)

  async function stage(file: File, allowDuplicate: boolean) {
    setBusy(true)
    setError(null)
    try {
      const result = await uploadImport({
        file,
        mode: 'records',
        targetObjectId: target?.id ?? null,
        allowDuplicate,
      })
      if (result.kind === 'duplicate') {
        setDuplicate({ file, previous: result.previous })
        return
      }
      await navigate({
        to: '/import/$batchId',
        params: { batchId: result.batchId },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stage this file')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ImportHeader
        mode="records"
        title={
          target
            ? `Import ${target.plural.toLowerCase()} from a spreadsheet`
            : 'Import from a spreadsheet'
        }
      />
      <StepStrip uploadHint={null} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-8 py-6">
        {duplicate ? (
          <PreviousImportNotice
            previous={duplicate.previous}
            action={
              <Button
                size="sm"
                pending={busy}
                onClick={() => void stage(duplicate.file, true)}
              >
                Stage again
              </Button>
            }
          />
        ) : null}
        <DropZone
          busy={busy}
          error={error}
          onFile={(file) => {
            setDuplicate(null)
            void stage(file, false)
          }}
        />
      </div>
    </div>
  )
}
