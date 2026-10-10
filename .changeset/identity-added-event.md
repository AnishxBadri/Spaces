---
'@spaces/sdk': minor
---

A fourth domain event, `identity.added`: a domain or an email added to a company or person after its birth, never by a seed or an import. It carries `key` (`domain` or `email`) and the `value` added, and an `event` job may subscribe to it with `on: ['identity.added']`.
