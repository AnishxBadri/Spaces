---
'@spaces/sdk': minor
---

The storage-source read port is typed: resolveLink, listFolder, getFolder, getFile, changes and pickerConfig return Effects with NotFound, CursorExpired, RateLimited and AuthExpired as typed failures; the testing kit exports a fake Drive and the read conformance suite; a manifest with provides: 'storage-source' is refused any job that uses Facts or Ai.
