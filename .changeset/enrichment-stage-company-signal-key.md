---
'@spaces/sdk': minor
---

Two vocabulary keys and a signal key. `company.funding_stage` is text the host matches to a select option by its exact label, never adding one. `person.company` uses a new value type, `company`, which is a company given by name and domain. The host links it to an existing company only while the link is empty, and offers an unknown one as an add card. A `SignalClaim` may carry a `key`, and a keyed signal is written once per (record, integration, key). `@spaces/sdk/testing`'s `ContentTest` dedupes on it, and `testPorts` takes `linked`.
