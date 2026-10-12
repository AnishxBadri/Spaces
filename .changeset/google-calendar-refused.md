---
'@spaces/plugin-google-calendar': patch
---

A revoked or expired calendar grant now fails `ConnectionRefused` rather than a plain permanent failure, so the host marks the connection in error with Google's reason — shown beside Reconnect on the account page — and never retries the run.
