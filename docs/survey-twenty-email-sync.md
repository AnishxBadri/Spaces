# Survey: Twenty CRM's email sync implementation

*Written 2026-08-12, from a code-level read of `twentyhq/twenty` (shallow clone at
HEAD of that date). Feeds the integrations phase — specifically the Gmail design
(CONTEXT.md Gmail block: forward-only, BYO GCP client). This documents how a
production open-source CRM does full-mailbox sync, what it costs, and what we
take from it.*

All file paths below are relative to `packages/twenty-server/src/` in the Twenty
repo unless noted.

## Summary

Twenty runs a **pull-based, two-stage, cron-driven pipeline** per connected
mailbox. A state machine on each `messageChannel` alternates between
*list-fetch* (ask the provider what changed since a cursor) and *import* (fetch
full bodies in batches), with a Redis set as the staging buffer between the
stages. Incremental sync rides provider cursors — Gmail `historyId`, Microsoft
Graph delta links, IMAP UID/QRESYNC. Provider webhooks (Gmail `watch`, Graph
subscriptions) accelerate the poll loop but never replace it. Messages land in
a normalized store deduped workspace-wide by RFC `Message-ID`; per-mailbox
membership is a join table; sharing is enforced by read-time redaction, not at
storage.

## 1. Data model

Six objects. `messageChannel`, `connectedAccount`, and `messageFolder` are
core-schema TypeORM entities (`engine/metadata-modules/*/entities/`); the rest
are per-workspace entities (`modules/messaging/common/standard-objects/`).

- **`connectedAccount`** — one per OAuth'd mailbox: `handle` (email address),
  `provider` (`GOOGLE | MICROSOFT | IMAP_SMTP_CALDAV`), `accessToken` /
  `refreshToken` **encrypted at rest** (`enc:v2:` prefix, enforced by DB CHECK
  constraint), `handleAliases[]` (the account's alias addresses), `scopes[]`,
  `authFailedAt` (set on permanent auth failure → drives the "reconnect"
  UX).
- **`messageChannel`** — one per synced mailbox; carries *all* sync state and
  all sharing policy: `syncStage`, `syncStatus`, `syncCursor` (Gmail
  historyId), `syncStageStartedAt`, `throttleFailureCount`,
  `throttleRetryAfter`, webhook subscription fields, plus the policy knobs —
  `visibility`, `isContactAutoCreationEnabled`, `contactAutoCreationPolicy`,
  `excludeNonProfessionalEmails`, `excludeGroupEmails`,
  `messageFolderImportPolicy` (`ALL_FOLDERS | SELECTED_FOLDERS`),
  `isSyncEnabled`.
- **`messageFolder`** — provider folder/label with its own `syncCursor`
  (Microsoft delta links and IMAP cursors are *per-folder*; Gmail's cursor is
  channel-level), `externalId`, `isSentFolder`, `pendingSyncAction`.
- **`message`** — the deduped payload: `headerMessageId` (RFC 5322
  Message-ID — **the workspace-wide dedup key**), `subject`, `text`,
  `receivedAt`, `messageThreadId`, `isDraft`.
- **`messageThread`** — provider-agnostic thread grouping; subject follows the
  latest message by `receivedAt`.
- **`messageChannelMessageAssociation` (MCMA)** — the join between a channel
  and a shared message: `messageExternalId` (provider message id),
  `messageThreadExternalId` (provider thread id), `direction`, folder links
  via a further join table. Plus **`blocklist`** (per-member, `handle` or
  `@domain`).

### Dedup and threading

`messaging-message.service.ts` (`saveMessagesWithinTransaction`): incoming
messages are looked up by `headerMessageId IN (...)`. A hit — from *any*
channel — creates no new `message` row, only a new MCMA pointing at the
existing one. So two teammates on the same email produce **one message, two
provenance edges**. (Gmail drafts can lack a Message-ID; a synthetic
`draft-${id}` substitutes.)

Thread resolution, in order: the existing message's `messageThreadId`; else an
existing MCMA in the same channel with the same `messageThreadExternalId`;
else earlier messages in the same batch sharing that external thread id; else
mint a new thread. Cross-channel thread mismatches are logged, not merged.

## 2. Sync state machine

Enums (in `twenty-shared`): `syncStage` =
`PENDING_CONFIGURATION → MESSAGE_LIST_FETCH_PENDING → …_SCHEDULED → …_ONGOING
→ MESSAGES_IMPORT_PENDING → …_SCHEDULED → …_ONGOING → (loop) | FAILED`;
`syncStatus` = `NOT_SYNCED | ONGOING | ACTIVE | FAILED_INSUFFICIENT_PERMISSIONS
| FAILED_UNKNOWN`. All transitions go through one writer,
`common/services/message-channel-sync-status.service.ts`.

Drivers of the machine — five cron jobs
(`message-import-manager/crons/jobs/`), each fanning out per-channel jobs onto
a worker queue:

| Cron | Schedule | Does |
|---|---|---|
| message-list-fetch | every 5 min | channels at `LIST_FETCH_PENDING` → CAS to `SCHEDULED` → enqueue fetch job. Skips throttled channels; skips channels with an ACTIVE webhook subscription unless the last sync is stale |
| messages-import | every 1 min | channels at `IMPORT_PENDING` → CAS → enqueue import job |
| ongoing-stale | hourly | resets channels stuck in ONGOING/SCHEDULED > 30 min (crash janitor) |
| relaunch-failed | every 30 min | re-launches `FAILED_UNKNOWN` channels; **never** auth failures (those wait for user reconnect) |
| sync-status monitoring | every 10 min | metrics/monitoring |

Scheduling uses atomic compare-and-swap updates (`.returning('id')`) so
concurrent crons can't double-schedule a channel, and worker jobs re-check the
stage on entry (idempotency guard).

**Webhooks are an accelerator, not the mechanism**:
`connected-account/webhook-subscription-manager/` creates Gmail `watch` /
Graph subscriptions (renewal cron hourly); on a push it just performs the same
CAS transition and enqueues the same fetch job early. Polling remains the
fallback for missed pushes.

## 3. Provider drivers

Dispatch switches on `connectedAccount.provider` in two services:
`messaging-get-message-list.service.ts` (IDs) and
`messaging-get-messages.service.ts` (bodies). Drivers under
`message-import-manager/drivers/`:

- **Gmail** — incremental via **History API**: `users.history.list` from the
  stored `historyId` (`historyTypes: messageAdded/Deleted, labelAdded/Removed`,
  500/page); next cursor is the returned `historyId`. First sync is a full
  paged `users.messages.list` with a `q=` filter excluding system/category
  labels, deriving the initial cursor from the newest message's `historyId`.
  Bodies fetched through a **batch endpoint wrapper, 50 per request**. Under
  `SELECTED_FOLDERS` policy it also pulls thread siblings so labeled threads
  are complete.
- **Microsoft** — **delta queries per folder**:
  `/mailfolders/{id}/messages/delta` resumed from the folder's stored
  `deltaLink`, issued through Graph `$batch` (20 folders/batch,
  `IdType="ImmutableId"`, 999/page). `@removed` entries drive deletions.
- **IMAP** — `imapflow`, per-folder cursors from UIDVALIDITY/UID with QRESYNC
  when the server supports it; sent-folder detection is heuristic (regex over
  folder names).
- **Inbound-email (`EMAIL_GROUP`)** — the no-sync lane: raw MIME read from
  S3 (SES), recipient matched to a channel by handle, parsed, saved through
  the same persistence service. **No cursors, no state machine, no OAuth.**

Token handling: refresh tokens decrypt on demand; the Google client relies on
googleapis auto-refresh. Per-provider constant lists of *permanent* OAuth error
codes distinguish "refresh token dead → reconnect" from transient network
failures.

## 4. Import pipeline

**Stage A — list fetch** (`messaging-message-list-fetch.service.ts`): mark
ONGOING → sync folder list → driver returns added/deleted external IDs →
dedup against existing MCMAs **in chunks of 200** → stage the new IDs into a
**Redis set** `messages-to-import:{workspace}:{channel}` with **1-week TTL** →
advance cursor (`messaging-cursor.service.ts` — channel-level cursor only
advances monotonically, guarding Gmail historyId regressions). On a *full*
sync it also sweeps MCMAs whose external IDs vanished from the provider
(deletion reconciliation) in id-paginated batches of 200. Nothing to import →
sync complete; else → import stage (started inline, cron as fallback).

**Stage B — import** (`messaging-messages-import.service.ts`): pop a
config-sized batch of IDs from the Redis set → fetch full bodies via driver →
map external folder ids → filter (blocklist, ICS-attachment invites,
internal-domain mail unless enabled, group/bulk mail unless self-sent —
`filter-emails.util.ts`) → persist transactionally → enqueue contact
creation. Popped a full batch → loop (back to `IMPORT_PENDING`, cron
re-fires); short batch → `ACTIVE`. **On error, popped IDs are pushed back
into the Redis set** before the exception handler runs — no work lost.

**Error taxonomy** (`messaging-import-exception-handler.service.ts`) — the
production-hardened part:

- *Temporary* (network errors, read timeouts, provider throttles) →
  exponential backoff: `1 min × 2^(failureCount−1)`, cap **5 attempts**,
  provider `Retry-After` honored; stage reset to PENDING. Past the cap →
  `FAILED_UNKNOWN` (the relaunch cron will retry later).
- *Auth* (invalid/missing refresh token, insufficient permissions) →
  `FAILED_INSUFFICIENT_PERMISSIONS`, `authFailedAt` set, account queued for
  the reconnect UX. Never auto-retried.
- *Cursor invalidation* (Gmail expires old historyIds) → wipe channel and
  folder cursors, restart full sync from zero.
- *NOT_FOUND* → fatal during list-fetch; resets to full sync during import.

## 5. Visibility, blocklist, contact creation

- **Visibility is per-channel, enforced at read time**
  (`common/query-hooks/message/apply-messages-visibility-restrictions.service.ts`):
  `SHARE_EVERYTHING | SUBJECT | METADATA`. Everything is always fully synced
  and stored; for non-owners a query hook redacts body (`SUBJECT`) or subject
  and body (`METADATA`) or splices the message out. The channel owner always
  sees everything. Default for new channels: `SHARE_EVERYTHING`.
- **Blocklist is retroactive**: adding `@domain` triggers a job that deletes
  already-synced matching MCMAs (and orphaned messages/threads); removing an
  entry triggers re-import.
- **Contact auto-creation** (`contact-creation-manager/`): policy default is
  **`SENT`-only** — participants of messages *you sent* become person
  records; inbound senders don't (automatic spam filter).
  `SENT_AND_RECEIVED` and `NONE` are the other options. A company record is
  created **only for work domains** (free-provider list — gmail.com etc. —
  produces a person with no company). Own workspace-member emails and
  same-work-domain colleagues are excluded. Person matching: `primaryEmail`
  then `additionalEmails`, case-insensitive; soft-deleted matches are
  restored.

## 6. Outbound

Separate path from sync: GraphQL `sendEmail` (permission-gated) → MIME via
nodemailer MailComposer → provider send API (Gmail `users.messages.send`,
thread via `threadId`; Graph; SMTP) → **optimistic local persist** of
message/MCMA/participants so it appears immediately. Persist failures are
swallowed deliberately — the pull sync of the Sent folder is the reconciler
of record. Drafts live locally as `isDraft` and are deleted from the provider
on send.

## 7. Takeaways for us

Our recorded Gmail design (CONTEXT.md: forward-only, BYO GCP client) is
deliberately *not* this. This survey prices the alternative: full-mailbox sync
costs an 8-stage state machine, 5 cron jobs, Redis staging, cursor-invalidation
recovery, webhook subscription renewal, and a read-time redaction layer.

1. **Forward-only maps to their `EMAIL_GROUP` driver** — their simplest lane:
   parse MIME, match recipient, persist. No cursors, no OAuth loop, no state
   machine. Both lanes share one persistence layer, so a later upgrade to real
   sync doesn't strand the v1.
2. **Steal the dedup/association split even for forward-only**: dedupe by RFC
   `Message-ID`, record per-source provenance as edges. Two teammates
   forwarding the same email = one message row, two provenance edges — the
   same idiom as our `entity_alias` / link graph.
3. **Sync everything, redact at read** is the same side of the fence as our
   canRead doctrine. If we ever build real sync, per-channel visibility must
   exist from day one; retrofitting redaction into a store that assumed
   share-everything is miserable.
4. **`SENT`-only contact creation is the right default** whenever
   participants→person creation lands: records for people *you emailed*
   filters spam by construction and matches investor behavior. Pair with a
   free-email-provider list: work domain → company; gmail.com → person only.
5. **Copy the error taxonomy into any external-API worker** (Apollo included,
   not just Gmail): temporary → capped exponential backoff with `Retry-After`
   and work pushed back onto the queue; auth-dead → surface reconnect, never
   auto-retry; cursor/state-invalid → reset to full resync. Plus the two
   janitors: a stale-ONGOING reset (crash recovery) and a failed-channel
   relauncher.
6. **Webhooks accelerate polling, they don't replace it** — the poll loop is
   the correctness backbone; pushes just make it fast. Cheap resilience
   pattern worth keeping if we ever subscribe to anything.
