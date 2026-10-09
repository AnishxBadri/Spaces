---
'@spaces/sdk': minor
---

The `watch` trigger (D72): a sixth trigger whose job runs once per saved watch on a space, on its cadence or on "Run now", handed `{ watchId, spaceId, settings, state }` and handing back `{ state }` — the plugin's own cursor, written back only when the run succeeds. A watch job declares its own `settings` zod schema (emitted as JSON Schema and rendered as the watch form; `watchSettingsOf` is the typed read), and a plugin declares at most one. Two ports join `PORT_NAMES`: `Spaces`, read-only, whose one call `brief(spaceId)` hands the space over as data — path, criteria, memos, terms, members with key values, the subtree with counts — and refuses a sensitive or archived space; and `Discover`, the hand-back of a found company, which the host does not provide yet. `@spaces/sdk/testing` gains `SpacesTest`, in `testPorts` too.
