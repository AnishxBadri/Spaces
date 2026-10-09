import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { clearRecordPicture, setRecordPicture } from '#/lib/server-fns'
import { PictureMark } from './record-parts'

/**
 * The record head's mark, with the picture controls under it: hovering or
 * focusing the mark offers "Change picture" and, when there is one,
 * "Remove". Either holds the picture, so enrichment never fills it again.
 */

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

const itemClass =
  'focus-ring-inset flex h-7 w-full items-center px-2 text-left text-ui whitespace-nowrap hover:bg-bone disabled:opacity-50'

export function RecordPicture({
  entityId,
  picture,
  fallback,
  size = 28,
}: {
  entityId: string
  picture: string | null
  /** The record's own mark, drawn when it has no picture. */
  fallback: ReactNode
  size?: number
}) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function run(write: () => Promise<unknown>, failed: string) {
    setBusy(true)
    try {
      await write()
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : failed)
    } finally {
      setBusy(false)
    }
  }

  function upload(file: File) {
    const form = new FormData()
    form.set('entityId', entityId)
    form.set('file', file)
    void run(
      () => setRecordPicture({ data: form }),
      'Could not set the picture',
    )
  }

  return (
    <div className="group relative shrink-0">
      <button
        type="button"
        aria-label="Change picture"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="focus-ring flex"
      >
        {picture ? <PictureMark src={picture} size={size} /> : fallback}
      </button>
      <div className="absolute top-full left-0 z-dropdown hidden pt-1 group-focus-within:block group-hover:block">
        <div className="flex min-w-32 flex-col rounded-none border border-hairline bg-paper p-1 shadow-dither">
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className={itemClass}
          >
            Change picture
          </button>
          {picture ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => clearRecordPicture({ data: { entityId } }),
                  'Could not remove the picture',
                )
              }
              className={itemClass}
            >
              Remove
            </button>
          ) : null}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.currentTarget.files?.item(0)
          e.currentTarget.value = ''
          if (file) upload(file)
        }}
      />
    </div>
  )
}
