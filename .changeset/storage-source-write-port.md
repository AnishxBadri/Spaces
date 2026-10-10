---
'@spaces/sdk': minor
'spaces': patch
---

The storage-source write half is typed: `ensureFolder(rootId, path)`, `putFile(folderId, name, { stream, mime, sha256 })` returning `{ fileId, revisionId, name }`, `move` and `rename`, optional on `StorageSource` and required on `WritableStorageSource`. The collision policy is the port's (`collisionName`: same sha is a revision, a different sha takes `name (2).ext`), and `ensureFolder` must hold under concurrency. The testing kit adds `storageSourceWriteConformance`, the fake Drive's write half and its tree, and the fake Drive API's folder create, update, delete and resumable upload. The Http port sends a `Uint8Array` body as bytes, which HttpLive passes through.
