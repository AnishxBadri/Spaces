---
'@spaces/plugin-apollo': patch
---

Apollo no longer declares the `autoEnrich` event job. The host's dispatcher never queued it — auto-enrich runs the host's `enrichment.run`, which presses Apollo's Enrich actions in the owner's scope — so the job and its handler are removed.
