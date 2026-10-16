---
'@spaces/plugin-google-drive': patch
---

`putFile` returns the uploaded file's `version` as `changeToken`, so the change poll sees our own write-through as unchanged and downloads nothing.
