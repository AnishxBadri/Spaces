---
'@spaces/sdk': minor
'spaces': patch
---

A syncer can file mail. `Content.logEmail` takes an `EmailClaim` — one message's RFC 5322 bytes as Gmail's `format=raw` returns them, its provider id, when it was received and its label names — and answers `created`, `duplicate` or `refused` with a reason. The host parses it, refuses noise and whatever the connection's exclude list names before anything is stored, resolves participants, files attachments, dedupes on the Message-ID (so a thread both forwarded and synced is one interaction) and decides who may read the body: the claim carries no visibility. A job may fail `ConnectionRefused` when the provider refuses the grant; the host marks the connection in error with that reason and does not retry. The testing kit's `ContentTest` dedupes emails on the Message-ID inside `raw`, and `makeFakeGmailApi` is Gmail's messages, history, labels and batch endpoints over a fake mailbox, with an expired history id, a 429 and a revoked token among its toggles.
