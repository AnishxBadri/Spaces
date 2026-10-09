---
'@spaces/plugin-apollo': minor
---

Apollo's event job is `autoEnrich`: it runs on `entity.created`, `filed` and `deal.linked` for companies (by domain) and people (by email or LinkedIn), gated by the host's auto-enrich scopes rather than an `autoEnrich` setting, which is gone. It uses `Content` and logs the latest funding round and a changed title as signals citing the receipt. Needs sdk ^1.2.
