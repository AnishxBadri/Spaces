---
'@spaces/sdk': minor
'@spaces/plugin-gmail': patch
---

An `EmailClaim` may carry `snippet`, the provider's plain-text preview of the body (Gmail's `snippet`). The host keeps it beside the headers and shows it under the subject until a summary has been written, and hides it with the body from anyone who may not read the body. Gmail sends its snippet, unescaped.
