import { Context, Effect, Layer } from 'effect'
import { JobPermanent } from '@spaces/sdk'
import type {
  JobError,
  MeetingResult,
  MeetingRsvp,
  MeetingStatus,
} from '@spaces/sdk'

/**
 * The meeting lane as a service: what `Content.logMeeting` hands a checked
 * claim to. Declared here and implemented where the arrival rules live —
 * the noise judgement and the participants module the mailbox runs on — so
 * a calendar attendee and a mail participant are judged by one policy.
 * - The lane decides: refuse, birth a row, or follow the one it holds,
 *   through `writeIntegrationInteraction` and `updateInteraction`.
 * - `NoMeetingLane` is for a process that runs ports but files no meetings.
 */

export type MeetingAttendeeInput = {
  /** Trimmed, lowercased. */
  email: string
  name: string | null
  rsvp: MeetingRsvp
  self: boolean
}

/** A meeting claim the port has checked: instants parsed, fields trimmed. */
export type MeetingInput =
  | {
      _tag: 'meeting'
      uid: string
      eventId: string
      status: MeetingStatus
      startsAt: Date
      endsAt: Date
      subject: string | null
      organizer: string | null
      conferenceUrl: string | null
      recurringInstanceId: string | null
      attendees: ReadonlyArray<MeetingAttendeeInput>
    }
  | { _tag: 'meeting-cancelled'; eventId: string; uid: string | null }

export type MeetingLaneContext = {
  /** The bound integration: `source_ref` on every row and record it makes. */
  integrationId: string
  /** The workspace user records it creates are created by. */
  authorId: string
}

export class MeetingLane extends Context.Service<
  MeetingLane,
  {
    readonly log: (
      ctx: MeetingLaneContext,
      input: MeetingInput,
    ) => Effect.Effect<MeetingResult, JobError>
  }
>()('spaces/core/MeetingLane') {}

export const NoMeetingLane: Layer.Layer<MeetingLane> = Layer.succeed(
  MeetingLane,
  MeetingLane.of({
    log: () =>
      Effect.fail(
        new JobPermanent({
          reason: 'Content.logMeeting: this process keeps no meetings',
        }),
      ),
  }),
)
