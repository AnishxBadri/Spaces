import { Effect, Layer } from 'effect'
import { JobRetryable } from '@spaces/sdk'
import { MeetingLane } from '@spaces/core/writes/interactions/meeting-lane'
import {
  logMeetingProgram,
  resolveAttendeesProgram,
} from '#web/lib/arrival/meeting'
import { messageOf } from './loader'

/**
 * The worker's `MeetingLane`: the calendar's arrival lane, which keeps the
 * noise rules and the participants module the mailbox runs on, and that
 * module alone for a recorder's participants. A write that
 * broke is retryable — the lane is keyed, so the retry writes nothing twice.
 */
export const meetingLaneLive: Layer.Layer<MeetingLane> = Layer.succeed(
  MeetingLane,
  MeetingLane.of({
    log: (ctx, input) =>
      logMeetingProgram(ctx, input).pipe(
        Effect.mapError(
          (error) =>
            new JobRetryable({
              reason: `Content.logMeeting failed: ${messageOf(error.cause)}`,
            }),
        ),
      ),
    participants: (ctx, people) =>
      resolveAttendeesProgram(ctx, people).pipe(
        Effect.mapError(
          (error) =>
            new JobRetryable({
              reason: `Content.logInteraction failed: ${messageOf(error.cause)}`,
            }),
        ),
      ),
  }),
)
