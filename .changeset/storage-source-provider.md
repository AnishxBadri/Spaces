---
'@spaces/sdk': minor
---

A plugin that provides a storage source hands core its provider: `definePlugin` takes `storageSource`, an Effect building the `StorageSource` over Http, Secrets, Log and Config — required when the manifest says `provides: 'storage-source'`, refused otherwise. The Http port gains `stream`, which hands a response body over unread for downloads of any size. The testing kit gains `makeFakeDriveApi`, Drive's v3 REST API in process over the fake Drive, and `HttpFetchTest`, an Http port over a fetch.
