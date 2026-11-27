import { notFound } from '@tanstack/react-router'
import { Schema } from 'effect'
import { getFileView } from '#/lib/server-fns'

/** The id shape `getFileView` validates; anything else is a wrong link. */
const isFileId = Schema.is(Schema.String.check(Schema.isUUID()))

/**
 * What a file's page (`/files/<id>`) loads. A file that is not there, or
 * that the reader may not read, throws `notFound()` so the route shows the
 * app's not-found page; every other failure rejects as it came.
 */
export async function loadFilePage(fileId: string) {
  if (!isFileId(fileId)) throw notFound()
  const view = await getFileView({ data: { id: fileId } })
  if (view === null) throw notFound()
  return view
}
