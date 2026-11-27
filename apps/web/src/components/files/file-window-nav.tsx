import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import type { ReactNode } from 'react'
import { fileWindowSearch } from '#/lib/modal-search'

/**
 * Opening and closing a file's window, which lives in its address
 * (`?modal=file&id=`, `&page=`) over whatever page opened it.
 * - Opening pushes an entry, so Back closes it. It takes the place of any
 *   other window's `modal` and `id`: a file opened from an email's window
 *   stands in front of it, and Back (or the close) brings the email back.
 * - The close steps back when this session pushed the window, and otherwise
 *   (a reload, a pasted link) drops the keys where it stands.
 */

/** The history index of the entry the last opener pushed. */
let pushedAt: number | null = null

/** Opens a file's window over this page, at a PDF's `page` when given. */
export function useOpenFile(): (id: string, page?: number | null) => void {
  const navigate = useNavigate()
  const router = useRouter()
  return useCallback(
    (id: string, page: number | null = null) => {
      void navigate({
        to: '.',
        search: (prev) => ({
          ...prev,
          page: undefined,
          ...fileWindowSearch(id, page),
        }),
        resetScroll: false,
      }).then(() => {
        pushedAt = router.state.location.state.__TSR_index
      })
    },
    [navigate, router],
  )
}

/** Closes the file's window: Back when it was opened here, else in place. */
export function useCloseFile(): () => void {
  const navigate = useNavigate()
  const router = useRouter()
  return useCallback(() => {
    const here = router.state.location.state.__TSR_index
    if (pushedAt !== null && pushedAt === here) {
      pushedAt = null
      router.history.back()
      return
    }
    void navigate({
      to: '.',
      search: (prev) => ({
        ...prev,
        modal: undefined,
        id: undefined,
        page: undefined,
      }),
      replace: true,
      resetScroll: false,
    })
  }, [navigate, router])
}

/**
 * A file's name as a link to its page: a click opens the window, `Enter`
 * and `Space` on it too; Cmd-click and a middle click open the page in a
 * new tab, as the browser does. It never also fires its row's click.
 */
export function FileNameLink({
  id,
  onOpen,
  className,
  title,
  children,
}: {
  id: string
  /** What a plain click does: the window, or Google's own tab. */
  onOpen: () => void
  className?: string | undefined
  title?: string | undefined
  children: ReactNode
}) {
  return (
    <Link
      to="/files/$fileId"
      params={{ fileId: id }}
      data-file-name
      {...(title === undefined ? {} : { title })}
      onClick={(e) => {
        e.stopPropagation()
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
          return
        e.preventDefault()
        onOpen()
      }}
      onKeyDown={(e) => {
        if (e.key !== ' ') return
        e.preventDefault()
        onOpen()
      }}
      className={className}
    >
      {children}
    </Link>
  )
}
