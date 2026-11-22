import { useClock } from '#/components/clock'
import {
  KeepCopyLine,
  Section,
  sourceLine,
  textLine,
  useDocumentDetails,
} from '#/components/files/viewer-sidebar'
import type { KeepCopy } from '#/components/files/keep-copy'
import type { RecordDocument } from '#/components/files/types'
import type { RemoteBytes } from '#/lib/documents/files-tab'
import type { EmailAttachment } from '#/lib/server-fns'

/**
 * The viewer's column over a thread: what was read of the file, and where
 * it came from — this email, the mailbox, and whether the file is kept here
 * or stays in Gmail. Filing and versions are the file card's `···`.
 */
export function AttachmentSidebar({
  attachment,
  doc,
  subject,
  keeper,
}: {
  attachment: EmailAttachment
  /** The viewer's card, re-read after a copy is kept. */
  doc: Pick<
    RecordDocument,
    'id' | 'extractionStatus' | 'extractionError' | 'url' | 'blobSha'
  > & { readonly remoteBytes: RemoteBytes }
  subject: string
  keeper: KeepCopy
}) {
  const { today } = useClock()
  const details = useDocumentDetails(doc.id)
  return (
    <>
      <Section label="Text">
        <p className="text-ui">{textLine(doc, details)}</p>
      </Section>
      <Section label="Source">
        <p data-source-email className="truncate text-ui">
          {subject || 'Untitled'}
        </p>
        <p data-source-line className="text-label text-graphite">
          {sourceLine(
            {
              sourceCapability: attachment.lane,
              uploadedByName: attachment.uploader,
              createdAt: attachment.addedAt,
            },
            today,
          )}
        </p>
        <KeepCopyLine doc={doc} keeper={keeper} />
      </Section>
    </>
  )
}
