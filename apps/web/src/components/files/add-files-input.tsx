import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { addFiles, registerFileChooser } from '#/lib/documents/arrivals'

/**
 * The system's file chooser, mounted once in the app shell so the Files
 * head, Cmd-K and Today's first run open the same one with
 * `chooseFilesToAdd`. The files picked land unfiled as rows on the Files
 * page, which opens if it is not the page already.
 */
export function AddFilesInput() {
  const ref = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const onFiles = useRouterState({
    select: (s) => s.location.pathname === '/files',
  })

  useEffect(() => registerFileChooser(() => ref.current?.click()), [])

  return (
    <input
      ref={ref}
      type="file"
      multiple
      aria-hidden
      tabIndex={-1}
      className="sr-only"
      onChange={(e) => {
        const files = e.target.files
        if (files !== null && files.length > 0) {
          addFiles(files)
          if (!onFiles) void navigate({ to: '/files' })
        }
        e.target.value = ''
      }}
    />
  )
}
