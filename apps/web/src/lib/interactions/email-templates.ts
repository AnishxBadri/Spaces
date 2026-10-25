import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { readEmailTemplateBody } from '@spaces/core/json'
import { db } from '@spaces/db'
import { template } from '@spaces/db/schema/templates'
import type { DraftAttachment } from '@spaces/db/schema/drafts'
import { DraftFailed, namedDocuments } from './email-drafts'
import type { DraftDocument } from './email-drafts'

/**
 * Email templates: `{subject, body, attachments}`, saved from the
 * composer and applied into a draft. Workspace-shared like every template.
 * - Applying copies; editing the template later never touches a draft.
 * - The files are re-read for the member applying it: a document they may
 *   not read is left off, never shown.
 */

export class EmailTemplateNotFound extends Schema.TaggedError<EmailTemplateNotFound>()(
  'EmailTemplateNotFound',
  { id: Schema.String },
) {}

/** The sentence a client is shown; a `Schema.TaggedError` carries none. */
export function emailTemplateMessage(failure: unknown): string {
  if (failure instanceof EmailTemplateNotFound)
    return 'That template is no longer there'
  return 'Could not read the template'
}

/** What applying a template copies into the draft. */
type EmailTemplateFill = {
  subject: string
  bodyMd: string
  attachments: Array<DraftDocument>
}

type EmailTemplateSave = {
  name: string
  subject: string
  bodyMd: string
  attachments: Array<DraftAttachment>
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DraftFailed({ cause }) })

/** Save as template: the draft's subject, body and files, under a name. */
export const saveEmailTemplateProgram = Effect.fn('saveEmailTemplateProgram')(
  function* (
    viewer: { id: string },
    input: EmailTemplateSave,
  ): Effect.fn.Return<{ id: string }, DraftFailed> {
    const row = (yield* query(() =>
      db
        .insert(template)
        .values({
          kind: 'email',
          name: input.name,
          body: {
            subject: input.subject,
            body_md: input.bodyMd,
            attachments: input.attachments.map((a) => ({
              documentId: a.documentId,
            })),
          },
          createdBy: viewer.id,
        })
        .returning({ id: template.id }),
    )).at(0)
    if (row === undefined)
      return yield* new DraftFailed({ cause: 'insert returned no row' })
    return row
  },
)

/** One template as applying it fills a draft, for the member applying it. */
export const emailTemplateProgram = Effect.fn('emailTemplateProgram')(
  function* (
    viewer: { id: string },
    id: string,
  ): Effect.fn.Return<EmailTemplateFill, DraftFailed | EmailTemplateNotFound> {
    const row = (yield* query(() =>
      db
        .select({ body: template.body })
        .from(template)
        .where(
          and(
            eq(template.id, id),
            eq(template.kind, 'email'),
            eq(template.archived, false),
          ),
        ),
    )).at(0)
    const body = row === undefined ? null : readEmailTemplateBody(row.body)
    if (body === null) return yield* new EmailTemplateNotFound({ id })
    const attachments = yield* namedDocuments(
      viewer.id,
      body.attachments.map((a) => a.documentId),
    )
    return { subject: body.subject, bodyMd: body.body_md, attachments }
  },
)
