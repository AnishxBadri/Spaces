---
'@spaces/plugin-gmail': minor
---

Gmail, forward-only. Every five minutes it reads the connected mailbox's new mail through Gmail's history feed and hands each message to the host, which files it on the people and companies in it with its attachments. The first run takes the mailbox's current history id and fetches nothing older than the connection; spam, trash and drafts are never synced, and one message the host cannot file is skipped without holding up the rest; when Gmail expires the history id the next run starts again from the connection date, never from the beginning of the mailbox. Bodies are private to the mailbox owner unless they share them; the exclude list (senders, domains and labels, with a default blocklist of Gmail's Promotions, Social, Updates and Forums tabs, Spam and the usual machine senders) is edited on the account page. Asks only `gmail.readonly`. Needs sdk ^1.5.
