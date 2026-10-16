---
'@spaces/sdk': minor
---

`PutFileResult` gains an optional `changeToken`: the file's change token as the upload left it, the value a listing or the change feed reports next. Core stores it on the exported document, so the poll reads its own write as no change. The in-memory fake Drive returns it.
