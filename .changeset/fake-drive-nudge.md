---
'@spaces/sdk': patch
---

The fake Drive gains `nudge(id)`: a change on the feed for an item with nothing changed, under the same `changeToken` — the case a change poll must not mistake for an edit.
