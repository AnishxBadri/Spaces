import { useRouter } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, Laptop, Link as LinkGlyph, icon } from '../icons'
import { ProviderMark } from '../provider-mark'
import { usePickerReadiness, usePickerSession } from '../storage-picker'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { FromDriveDialog, PasteLinkDialog } from '../upload-dialog'
import { chooseFilesToAdd } from '#/lib/documents/arrivals'
import type { PickedEntity } from '#/lib/documents/file-against'
import { attachFromPicker } from '#/lib/server-fns'
import type { PickedFile } from '#/lib/server-fns'

/**
 * The Files head's `[Upload | ▾]`: the left half opens the system's file
 * chooser and the files land unfiled as rows; the menu holds `From this
 * computer`, `From Google Drive…` (only while Drive can open, as on a
 * record's Files tab) and `Paste a link`.
 */
export function UploadButton() {
  const router = useRouter()
  const [readiness, setReadiness] = usePickerReadiness()
  const [drive, setDrive] = useState(false)
  const [link, setLink] = useState(false)
  const [recordName, setRecordName] = useState<string | null>(null)
  // Read when Drive's picker answers, after the window that chose it closed.
  const onto = useRef<PickedEntity | null>(null)
  const picker = usePickerSession({
    mode: 'files',
    ...(recordName === null ? {} : { recordName }),
    onPicked: (files) => void attach(files),
    onBlocked: setReadiness,
  })

  async function attach(files: ReadonlyArray<PickedFile>) {
    const record = onto.current
    if (record === null) return
    try {
      const outcome = await attachFromPicker({
        data: {
          provider: 'google',
          attachTo: record.entityId,
          files: files.map((f) => ({ id: f.id, name: f.name })),
          returnTo: window.location.pathname,
        },
      })
      if (outcome._tag === 'queued') {
        toast.success(
          `Fetching ${String(outcome.files.length)} from Drive · ${record.name}`,
        )
        void router.invalidate()
      } else if (outcome._tag === 'connect') {
        toast(outcome.label, {
          action: {
            label: 'Connect',
            onClick: () => window.location.assign(outcome.href),
          },
        })
      } else toast.error(outcome.reason)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not attach these files',
      )
    }
  }

  return (
    <span data-upload-split className="inline-flex gap-px">
      <Button onClick={chooseFilesToAdd} className="rounded-r-none">
        <icon.upload aria-hidden className="size-4" />
        Upload
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            aria-label="Upload from"
            data-upload-menu
            className="w-7 rounded-l-none"
          >
            <ChevronDown aria-hidden className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem icon={<Laptop />} onSelect={chooseFilesToAdd}>
            From this computer
          </DropdownMenuItem>
          {readiness?._tag === 'ready' ? (
            <DropdownMenuItem
              icon={<ProviderMark brand="googleDrive" />}
              disabled={picker.opening}
              onSelect={() => setDrive(true)}
            >
              From Google Drive…
            </DropdownMenuItem>
          ) : readiness?._tag === 'consent' ? (
            <DropdownMenuItem
              icon={<ProviderMark brand="googleDrive" />}
              title="Google asks once more, for the files you pick."
              onSelect={() => window.location.assign(readiness.href)}
            >
              From Google Drive…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem icon={<LinkGlyph />} onSelect={() => setLink(true)}>
            Paste a link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <FromDriveDialog
        open={drive}
        onOpenChange={setDrive}
        onChoose={(record) => {
          onto.current = record
          setRecordName(record.name)
          void picker.open()
        }}
      />
      <PasteLinkDialog open={link} onOpenChange={setLink} />
      {picker.sheet}
    </span>
  )
}
