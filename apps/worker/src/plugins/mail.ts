import { Effect, Layer } from 'effect'
import { JobRetryable } from '@spaces/sdk'
import { EmailLane } from '@spaces/core/writes/interactions/email-lane'
import { logSyncedEmailProgram } from '#web/lib/arrival/synced'
import { messageOf } from './loader'

/**
 * The worker's `EmailLane`: the synced mailbox's arrival lane, on the
 * forwarding mailbox's parser, noise rules and participants module. A write
 * that broke is retryable — the lane dedupes on the Message-ID, so the retry
 * writes nothing twice.
 */
export const mailLaneLive: Layer.Layer<EmailLane> = Layer.succeed(
  EmailLane,
  EmailLane.of({
    log: (ctx, input) =>
      logSyncedEmailProgram(ctx, input).pipe(
        Effect.mapError(
          (error) =>
            new JobRetryable({
              reason: `Content.logEmail failed: ${messageOf(error.cause)}`,
            }),
        ),
      ),
  }),
)
