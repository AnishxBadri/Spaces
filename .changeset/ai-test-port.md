---
'@spaces/sdk': minor
---

The testing kit exports `AiTest` — scripted answers by lane, a structured answer parsed by the caller's schema — and `testPorts` provides it beside the other ports. The host now provides `Ai` live: sensitivity is resolved from the record the job runs on, never from what the plugin passes, and a `schedule` job may call the `classify` lane only.
