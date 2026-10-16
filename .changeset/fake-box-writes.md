---
'@spaces/sdk': minor
---

The fake Box answers writes: `POST folders`, a multipart upload to `upload.box.com` (a new file, or a new version of one) and `PUT files/:id` or `folders/:id` to move or rename. Names are unique in a folder ignoring case, so a namesake is Box's 409 `item_name_in_use` naming the item in the way (a list for a folder create, one object with its `sha1` for an upload); an upload whose `content-md5` is not its bytes' SHA-1 is a 412. A held file's `sha1` is now its real SHA-1 (`sha1Hex`, exported). `FAKE_BOX_SEED` holds the fake Drive's fourteen data-room files under the same folders, and `FAKE_BOX_WRITE_FIXTURE` runs a Box plugin through `storageSourceWriteConformance`.
