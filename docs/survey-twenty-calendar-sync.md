# Survey: Twenty CRM's calendar sync implementation

_Written 2026-08-13, from a code-level read of `twentyhq/twenty` (same shallow
clone as the email survey — see `survey-twenty-email-sync.md`). Feeds the
integrations phase: calendar sync is a candidate rider on phase ④ (Google
Workspace — shared OAuth/`account_connection` substrate), and unlike Gmail it
has no forward-only equivalent, so if we do it at all we do a real read-only
pull._

All file paths relative to `packages/twenty-server/src/` in the Twenty repo
unless noted.

## Summary

Twenty's calendar sync is a **structural clone of its email pipeline**: the
same two-stage cron-driven state machine (list-fetch → import) per
`calendarChannel`, the same Redis staging set, the same throttle/backoff and
error taxonomy, the same webhook-accelerates-polling pattern. The differences
are where calendars differ from mailboxes: events are **mutable** (updated in
place on re-sync, participants diffed), cancellations are deletions, recurring
events are synced as **expanded instances**, and the whole thing is far
lighter — batch size 100, primary calendar only, tiny payloads. Two observed
robustness gaps: per-channel dedup is app-level only (no unique DB index —
their own TODO admits it), and Google's expired-sync-token (HTTP 410) is
silently swallowed into a full re-sync instead of routing through the error
handler.

## 1. Data model

Same split as messaging: `calendarChannel` + `connectedAccount` are
core-schema TypeORM entities; events/participants/associations are
per-workspace objects.

- **`calendarChannel`**
  (`engine/metadata-modules/calendar-channel/entities/calendar-channel.entity.ts`) —
  one per connected calendar account: `handle`, `syncStage`, `syncStatus`,
  **`syncCursor`** (Google syncToken / Graph deltaLink / CalDAV JSON blob),
  `syncedAt`, `syncStageStartedAt`, `throttleFailureCount`, `visibility`,
  `isContactAutoCreationEnabled`, `contactAutoCreationPolicy` (default
  `AS_PARTICIPANT_AND_ORGANIZER`), `isSyncEnabled`, webhook subscription
  fields (external id, client state, status, expiry). Index on
  `(workspaceId, isSyncEnabled, syncStage)`.
- **`calendarEvent`**
  (`modules/calendar/common/standard-objects/calendar-event.workspace-entity.ts`) —
  `title`, `description`, `location`, `startsAt`/`endsAt`, `isFullDay`,
  `isCanceled`, `externalCreatedAt`/`externalUpdatedAt`, `iCalUid`,
  `conferenceSolution`, `conferenceLink`. No recurrence-rule storage.
- **`calendarEventParticipant`** — `handle`, `displayName`, `isOrganizer`,
  `responseStatus` (`NEEDS_ACTION | DECLINED | TENTATIVE | ACCEPTED`),
  nullable `personId` / `workspaceMemberId` (matched post-import).
- **`calendarChannelEventAssociation`** — the channel↔event join:
  `eventExternalId`, `recurringEventExternalId`, `calendarChannelId`,
  `calendarEventId`.

### Dedup — weaker than email's

Dedup is **per-channel only**, keyed `(eventExternalId, calendarChannelId)` in
application code (`calendar-save-events.service.ts`). **No cross-channel dedup
by `iCalUid`** — the same real meeting synced from two members' calendars
produces two `calendarEvent` rows. (Email dedupes workspace-wide by RFC
Message-ID; calendar stores `iCalUid` but never matches on it.) There is also
**no unique DB index** backing the app-level dedup — a code TODO
(`calendar-save-events.service.ts:284`) acknowledges duplicate-row risk.

### Recurring events

Google is queried with `singleEvents: true`, so recurrence arrives
**pre-expanded into individual instances**; each instance is its own
`calendarEvent`, with the master's id kept in
`association.recurringEventExternalId`. No RRULE handling anywhere.

## 2. Sync state machine

Identical shape to messaging. Enums in `twenty-shared`:
`syncStage` = `PENDING_CONFIGURATION → CALENDAR_EVENT_LIST_FETCH_PENDING →
…_SCHEDULED → …_ONGOING → CALENDAR_EVENTS_IMPORT_PENDING → …_SCHEDULED →
…_ONGOING → (loop) | FAILED`; `syncStatus` = `NOT_SYNCED | ONGOING | ACTIVE |
FAILED_INSUFFICIENT_PERMISSIONS | FAILED_UNKNOWN`. One transition writer:
`modules/calendar/common/services/calendar-channel-sync-status.service.ts`.

Four crons (on the shared cron queue, dispatching to a calendar worker queue):

| Cron             | Schedule     | Does                                                                                                                                            |
| ---------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| event-list-fetch | every 5 min  | CAS `LIST_FETCH_PENDING → SCHEDULED`, enqueue fetch; skips throttled; skips channels with an ACTIVE webhook subscription unless last sync stale |
| events-import    | every 1 min  | schedules import for `IMPORT_PENDING` channels                                                                                                  |
| ongoing-stale    | hourly       | resets channels stuck ONGOING/SCHEDULED > 30 min                                                                                                |
| relaunch-failed  | every 30 min | re-launches `FAILED_UNKNOWN`; never auth failures                                                                                               |

Throttling literally shares messaging's constants (`isThrottled` imports
`MESSAGING_THROTTLE_DURATION`; exponential `1 min × 2^(failures−1)`, cap 5).

## 3. Provider drivers

Dispatch on `connectedAccount.provider` in `calendar-get-events.service.ts`.

- **Google**
  (`drivers/google-calendar/services/google-calendar-get-events.service.ts`) —
  `events.list({ calendarId: 'primary', maxResults: 500, singleEvents: true,
syncToken, showDeleted: true })`. Empty cursor → full sync; stored cursor →
  incremental; new cursor = returned `nextSyncToken`. `status: 'cancelled'`
  items become the delete list. **Primary calendar only.** **No
  `timeMin`/`timeMax` on initial sync — full history imported.**
  **Gap:** HTTP 410 (expired syncToken) is swallowed in `handleError` — the
  catch returns empty items with no token, so the next run silently performs
  a full re-sync rather than routing through `SYNC_CURSOR_ERROR`.
  Hydration is per-event `events.get` in parallel (404/410 → dropped).
- **Microsoft**
  (`drivers/microsoft-calendar/`) — Graph **delta query**
  `/me/calendar/events/delta` (beta) with `PageIterator`; cursor =
  `deltaLink`; `@removed` → deletions. Primary calendar only.
- **CalDAV** (`drivers/caldav/`) — the thorough one: **all VEVENT calendars**
  (not just primary), per-calendar cursors packed as a JSON blob in the one
  `syncCursor` field (`{ syncTokens, ctags?, etags? }` keyed by calendar
  URL). Uses RFC 6578 sync-collection when the server supports it, else
  ctag/etag diffing; invalid token → per-calendar full re-sync. Only CalDAV
  bounds time: 5 years back, 1 year forward, applied at hydration.

Webhook push (`connected-account/webhook-subscription-manager/`,
`connected-account-sync-webhooks/`): Google `events.watch` on primary with a
7-day TTL (watches can't be renewed — a fresh channel is created and the old
one stopped), Microsoft Graph subscriptions (7-day TTL), hourly renewal cron
with a 24 h buffer. Inbound `POST /webhooks/google/calendar` verifies the
channel token with `timingSafeEqual`, ignores the initial `sync` ping, and
triggers the same CAS transition the cron would — push is the primary
trigger, the 5-min poll is the fallback.

## 4. Import pipeline

- List-fetch stages external ids into Redis set
  `calendar-events-to-import:{workspace}:{channel}`; import pops
  **batches of 100** (`CALENDAR_EVENT_IMPORT_BATCH_SIZE`); full batch → loop,
  short batch → sync complete. DB writes batched at 1000.
- **Events are mutable** — the key divergence from messaging: existing events
  (matched by association `eventExternalId` + channel) are **updated in
  place** with fresh field values incl. `externalUpdatedAt`; participants are
  diffed by handle — new added, changed updated, absent **deleted**.
- **Cancellations**: two paths — provider-reported deletions at list-fetch
  (Google cancelled / Graph `@removed` / CalDAV 404) delete associations, and
  `isCanceled` events at import get their associations deleted too. A cleaner
  (`calendar-event-cleaner.service.ts`) then removes any event with zero
  remaining associations.
- **Filtering**: an event is dropped only if **every** participant is
  blocklisted (blocklist matched against the channel handle + account
  aliases). Participant-less events are kept; all-day events are kept
  (`isFullDay` is just a flag). No solo/internal-meeting filter.
- Error taxonomy: separate class
  (`calendar-event-import-exception-handler.service.ts`) but same pattern as
  messaging — temporary → capped exponential backoff; auth →
  `FAILED_INSUFFICIENT_PERMISSIONS` + reconnect flag; `SYNC_CURSOR_ERROR` →
  cursor reset + refetch; unknown → `FAILED_UNKNOWN` + Sentry.

## 5. Visibility & contact creation

- **Visibility has only two levels** — `METADATA | SHARE_EVERYTHING`
  (email has three; there's no calendar SUBJECT tier). Enforced at read time
  by post-query hooks
  (`apply-calendar-events-visibility-restrictions.service.ts`): any
  SHARE_EVERYTHING channel → full; owner → full; METADATA → `title` and
  `description` redacted; otherwise the event is spliced from results.
  Applied across user, API-key, and application auth contexts.
- **Contact auto-creation policy** on the channel:
  `AS_PARTICIPANT_AND_ORGANIZER` (default) | `AS_PARTICIPANT` |
  `AS_ORGANIZER` | `NONE`. The calendar module enqueues _all_ participants
  (`source: CALENDAR`) onto the shared contact-creation queue; the policy
  filter, work-vs-personal-domain rules, and self/colleague exclusion all
  live downstream in `contact-creation-manager/` — the same machinery email
  uses. Participant→person matching runs on every import
  (`matchWith: 'workspaceMemberAndPerson'`).

## 6. Takeaways for us

1. **Calendar is the cheap sync, confirmed in code.** Same skeleton as email
   but: batch 100 vs mailbox-scale volume, primary calendar only, tiny
   structured payloads, no threading, no attachment/body storage, only two
   visibility tiers. If we build one real sync, this is the one — and the
   `syncToken` loop is simple enough that our version (single-tenant, one
   provider) needs none of the Redis staging: fetch-diff-apply in one worker
   job is plausible at our scale.
2. **Dedupe cross-channel by `iCalUid` from day one** — Twenty stores it but
   doesn't use it, so two teammates at the same meeting means two event rows.
   With our entity/alias idiom the fix is free at design time and ugly to
   retrofit: one event entity, per-source provenance edges (same rule as the
   email survey's Message-ID lesson). Also: put a **unique index** under
   whatever dedup key we choose — their app-level-only dedup has a TODO
   admitting duplicate rows.
3. **Events are mutable state, not append-only events.** Calendar entries get
   edited and cancelled upstream; Twenty updates in place and diffs
   participants. For us this means calendar data belongs in a
   mirror-shaped table (upsert semantics, `externalUpdatedAt`), _not_ in the
   phase-15 append-only family — it's a cache of someone else's mutable
   truth, which also means the event-correction question doesn't apply to it.
4. **Recurring events: sync expanded instances** (`singleEvents: true`) and
   keep the master id as provenance. Never store RRULEs — expansion is the
   provider's job.
5. **Bound the initial import window.** Twenty's Google driver imports _all
   history_ (no `timeMin`) — for meeting-recency features, ~2 years back is
   plenty and keeps first sync fast. (Only their CalDAV driver bounds time;
   copy that instinct, not the Google driver's.)
6. **Filter differently than they do.** Twenty keeps participant-less events;
   for a CRM timeline, solo blocks and internal-only meetings are noise —
   skip events with no external participant by default (our planned rule),
   and blocklist-check the rest at import like they do.
7. **Handle cursor expiry loudly.** Google 410 silently degrading to a full
   re-sync works but hides cost and masks bugs; route expiry through the
   error path with a log/metric (their own Microsoft/CalDAV drivers do it
   properly — the Google driver is the outlier).
8. **Webhooks optional at our scale.** Push with 7-day non-renewable watches
   - renewal cron + handshake verification is real machinery; a 5-minute (or
     even 15-minute) poll alone is fine for meeting-prep and recency features
     at 1–15 users. Add push only if staleness ever actually bites.
