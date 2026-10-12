---
'@spaces/sdk': minor
---

A manifest may declare `mcp: { url, auth }`: a remote MCP server Ask mounts for a turn while the integration runs (D72). `url` is https; `auth.header` names the header the workspace key goes in (with an optional `Bearer` scheme), so a manifest with `mcp` must also declare `requires.credential` — the key comes from the vault through the host, never from the manifest. The host proxies every call through the integration's throttle and daily credit cap, records it against the integration, and mounts nothing for a turn whose scope is sensitive.
