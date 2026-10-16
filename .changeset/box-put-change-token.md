---
'@spaces/plugin-box': patch
---

`putFile` asks for and returns the uploaded file's `etag` as `changeToken`, so the change poll sees our own write-through as unchanged and downloads nothing.
