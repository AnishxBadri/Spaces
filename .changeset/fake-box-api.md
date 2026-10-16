---
'@spaces/sdk': minor
---

The testing kit gains a fake Box: `makeFakeBoxApi()` answers Box's content API (`folders/:id/items` with marker paging and `fields`, `folders/:id` and `files/:id` with `path_collection`, `files/:id/content` as a redirect to a download, `shared_items`, `users/me`), Box Notes' `extracted_text` representation, the events stream with 64-bit stream positions and a retained window (`evictCursors` makes an older position a 400), and OAuth whose refresh token is single-use (`oauth.lapse()` expires them all). `FAKE_BOX_SEED`, `FAKE_BOX_FIXTURE`, `FAKE_BOX_CHAOS_FIXTURE` and `FAKE_BOX_SCAN` run a Box plugin through `storageSourceConformance` and `storageSourceChaos`; every Drive export is unchanged.
