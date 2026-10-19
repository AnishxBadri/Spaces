import { Context, Effect, Layer } from 'effect'
import { JobPermanent } from '@spaces/sdk'
import type { EmailResult, JobError } from '@spaces/sdk'

/**
 * The synced-mail lane as a service: what `Content.logEmail` hands a checked
 * claim to. Declared here and implemented where the arrival rules live — the
 * parser, the noise judgement, the exclude list and the participants module
 * the forwarding mailbox runs on — so a synced message and a forwarded one
 * are judged by one policy and dedupe on one Message-ID index.
 * - The lane reads the bound connection itself: whose mailbox it is decides
 *   who may read the body (D67), and no claim field may say otherwise.
 * - `NoEmailLane` is for a process that runs ports but files no mail.
 */

/** An email claim the port has checked: bytes decoded, instant parsed. */
export type EmailInput = {
  providerMessageId: string
  /** The RFC 5322 bytes. */
  raw: Uint8Array
  receivedAt: Date
  /** Label names, trimmed; empties dropped. */
  labels: ReadonlyArray<string>
  /** The provider's preview of the body, trimmed; absent when empty. */
  snippet?: string
}

export type EmailLaneContext = {
  /** The bound integration: `source_ref` on every row and record it makes. */
  integrationId: string
}

export class EmailLane extends Context.Service<
  EmailLane,
  {
    readonly log: (
      ctx: EmailLaneContext,
      input: EmailInput,
    ) => Effect.Effect<EmailResult, JobError>
  }
>()('spaces/core/EmailLane') {}

export const NoEmailLane: Layer.Layer<EmailLane> = Layer.succeed(
  EmailLane,
  EmailLane.of({
    log: () =>
      Effect.fail(
        new JobPermanent({
          reason: 'Content.logEmail: this process keeps no mail',
        }),
      ),
  }),
)
