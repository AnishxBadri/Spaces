---
'@spaces/sdk': minor
---

The testing kit adds the storage-source chaos list: storageSourceChaos runs a provider through a 429 with Retry-After, a file deleted between list and get, half a batch failing, an expired change cursor, a replayed change page, a token revoked mid-run and a 200 MB file streamed under a memory bound, each as a typed failure; the fake Drive gains a chaos handle and large files whose bytes are generated as they are read.
