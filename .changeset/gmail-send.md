---
'@spaces/sdk': minor
'@spaces/plugin-gmail': minor
'spaces': patch
---

Email sends from Spaces through Gmail (D67). An action job may declare `input: 'payload'`: the host hands it a payload it prepared instead of a record, with no credit guard, and no manifest `actions` entry may name it — Send on a draft. `OutgoingEmail` is that payload for a mail plugin: the host-minted Message-ID, From, To, Cc, Bcc, the resolved subject and markdown body, `In-Reply-To` and `References`, and each file as a short-lived blob URL, never more than `OUTGOING_EMAIL_LIMIT_BYTES` (25 MB) together. Gmail gains `send`, an interactive action that is never retried: it finds the parent's thread by Message-ID, builds the MIME (text and HTML alternatives, each file once), sends it through the `messages.send` upload with `gmail.send`, and hands the mailbox's sent copy to `Content.logEmail`, so the outgoing row and a later sync dedupe on one Message-ID; a message the mailbox already holds is not sent twice. The connection now asks `gmail.send` too; one made before still syncs, and the composer asks to reconnect it before it sends. The fake Gmail takes `messages.send`, finds by `rfc822msgid:`, keeps the sent copy with its Bcc for the next sync, logs each sent message's headers and parts, and `failNext` answers one request with a Google error.
